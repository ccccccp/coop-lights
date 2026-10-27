import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import pg from 'pg'
import { afterEach, expect, test } from 'vitest'

import { createMockOAuth } from '../../../tests/support/oauth'
import { createApp } from '../src/app'
import { getConfig, projectRoot } from '../src/config'
import { LoginTransactions } from '../src/platform'
import { PostgresRepository } from '../src/storage'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture(allowedOrigins = ['https://game.test']) {
  const base = getConfig()
  const schema = `lights_test_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Client({ connectionString: base.databaseUrl })
  await admin.connect()
  await admin.query(`CREATE SCHEMA ${schema}`)
  cleanups.push(async () => {
    await admin.query(`DROP SCHEMA ${schema} CASCADE`)
    await admin.end()
  })
  await admin.query(`SET search_path TO ${schema}`)
  await admin.query(await readFile(resolve(projectRoot, 'db/migrations/001_initial.sql'), 'utf8'))
  const oauth = await createMockOAuth()
  cleanups.push(oauth.close)
  const repo = await new PostgresRepository(base.databaseUrl, schema).init()
  const config = {
    ...base,
    mode: 'kook' as const,
    tls: undefined,
    devFaults: false,
    allowedOrigins,
    kook: oauth.config,
  }
  const { app } = await createApp(config, repo)
  cleanups.push(() => app.close())
  async function http(path: string, cookie = '', body?: unknown, origin = 'https://game.test', authorization?: string) {
    const response = await app.inject({
      method: body === undefined ? 'GET' : 'POST',
      url: path,
      headers: { origin, cookie, 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    })
    const cookies = response.headers['set-cookie'] ?? []
    const list = Array.isArray(cookies) ? cookies : [cookies]
    return {
      status: response.statusCode,
      data: response.json(),
      cookie: list.map((value) => value.split(';')[0]).join('; '),
      headers: list.join(';'),
      cacheControl: response.headers['cache-control'],
    }
  }
  async function start() {
    return http('/api/kook/login/start', '', {})
  }
  async function login() {
    const transaction = await start()
    const result = await http('/api/kook/login/complete', transaction.cookie, {
      state: transaction.data.state,
      code: oauth.issue('alice'),
    })
    return { transaction, result }
  }
  return { http, start, login, oauth, repo, app }
}

test('OAuth creates a browser-bound one-use transaction and a server-verified game identity', async () => {
  const f = await fixture()
  const transaction = await f.start()
  expect(transaction.status).toBe(200)
  expect(transaction.headers).toContain('HttpOnly')
  expect(transaction.headers).toContain('Secure')
  expect(transaction.headers).toContain('SameSite=None')
  expect(transaction.headers).toContain('Partitioned')
  const payload = { state: transaction.data.state, code: f.oauth.issue('alice') }
  expect((await f.http('/api/kook/login/complete', '', payload)).status).toBe(401)
  expect(f.oauth.exchanges()).toBe(0)
  const result = await f.http('/api/kook/login/complete', transaction.cookie, payload)
  expect(result.status).toBe(200)
  expect(result.data.user.nickname).toBe('模拟玩家阿青')
  expect(JSON.stringify(result.data)).not.toMatch(/access_token|refresh_token|client_secret|openCode|appId/)
  expect((await f.http('/api/session', result.cookie)).status).toBe(200)
  expect((await f.http('/api/kook/login/complete', transaction.cookie, payload)).status).toBe(401)
  expect(f.oauth.exchanges()).toBe(1)
  expect((await f.http('/api/rooms', result.cookie, {})).data.room.platformInstanceId).toBeNull()
})

test('OAuth rejects foreign origin, spoofed identity and instance data without exchanging code', async () => {
  const f = await fixture()
  expect((await f.http('/api/kook/login/start', '', {}, 'https://evil.test')).status).toBe(403)
  expect((await f.http('/api/dev/session', '', { nickname: '伪造用户' })).status).toBe(503)
  const tx = await f.start()
  expect(
    (
      await f.http('/api/kook/login/complete', tx.cookie, {
        state: tx.data.state,
        code: f.oauth.issue('alice'),
        userOpenCode: 'someone-else',
        instanceId: 'fake-instance',
      })
    ).status
  ).toBe(400)
  expect(f.oauth.exchanges()).toBe(0)
})

test('cancelling an in-flight exchange prevents a late login from establishing a session', async () => {
  const f = await fixture()
  f.oauth.setDelay(150)
  const tx = await f.start()
  const pending = f.http('/api/kook/login/complete', tx.cookie, { state: tx.data.state, code: f.oauth.issue('alice') })
  await expect.poll(f.oauth.exchanges).toBe(1)
  await f.http('/api/kook/login/cancel', tx.cookie, { state: tx.data.state })
  const result = await pending
  expect(result.status).toBe(401)
  expect(result.cookie).toBe('')
})

test('logout revokes the issued session and login cannot accept a failed exchange', async () => {
  const f = await fixture()
  const { transaction, result } = await f.login()
  expect((await f.http('/api/logout', `${transaction.cookie}; ${result.cookie}`, {})).status).toBe(200)
  expect((await f.http('/api/session', result.cookie)).status).toBe(401)
  const tx = await f.start()
  const failed = await f.http('/api/kook/login/complete', tx.cookie, { state: tx.data.state, code: 'unknown-code' })
  expect(failed.status).toBe(502)
  expect(failed.cookie).toBe('')
  expect(JSON.stringify(failed.data)).not.toContain('unknown-code')
})

test('transaction expiry, replacement and reuse fail closed', () => {
  const transactions = new LoginTransactions()
  const old = transactions.begin('browser-a')
  const latest = transactions.begin('browser-a')
  expect(() => transactions.consume(old, 'browser-a')).toThrow()
  expect(() => transactions.consume(latest, 'browser-b')).toThrow()
  const active = transactions.consume(latest, 'browser-a')
  expect(() => transactions.consume(latest, 'browser-a')).toThrow()
  transactions.cancel('browser-a')
  expect(() => transactions.assertActive(active)).toThrow()
  const next = transactions.consume(transactions.begin('browser-a'), 'browser-a')
  next.expiresAt = Date.now() - 1
  expect(() => transactions.assertActive(next)).toThrow()
})

test('Cookie 不可用时以 nonce 完成原登录协议，游戏 Bearer 会话可建房和取得 WebSocket 票据', async () => {
  const f = await fixture()
  const clientNonce = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '')
  const transaction = await f.http('/api/kook/login/start', '', { clientNonce })
  const payload = { state: transaction.data.state, code: f.oauth.issue('alice'), clientNonce }
  expect((await f.http('/api/kook/login/complete', '', { ...payload, clientNonce: '0'.repeat(64) })).status).toBe(401)
  expect(
    (await f.http('/api/kook/login/complete', transaction.cookie, { state: payload.state, code: payload.code })).status
  ).toBe(401)
  expect(f.oauth.exchanges()).toBe(0)
  const result = await f.http('/api/kook/login/complete', '', payload)
  expect(result.status).toBe(200)
  expect(result.data.gameToken).toMatch(/^[a-f0-9]{64}$/)
  expect(result.cacheControl).toBe('no-store')
  const authorization = `Bearer ${result.data.gameToken}`
  expect((await f.http('/api/session', '', undefined, 'https://game.test', authorization)).status).toBe(200)
  expect((await f.http('/api/rooms', '', {}, 'https://game.test', authorization)).status).toBe(200)
  const ticket = await f.http('/api/ws-tickets', '', {}, 'https://game.test', authorization)
  expect(ticket.status).toBe(200)
  expect(ticket.data.ticket).toMatch(/^[a-f0-9]+$/)
  const user = await f.repo.getUser(result.data.user.id)
  expect(user?.appId).toBe(f.oauth.config.clientId)
  expect(JSON.stringify(result.data)).not.toMatch(/access_token|refresh_token|client_secret|openCode|appId/)
  expect((await f.http('/api/kook/login/complete', '', payload)).status).toBe(401)
  expect((await f.http('/api/logout', '', {}, 'https://game.test', authorization)).status).toBe(200)
  expect((await f.http('/api/session', result.cookie, undefined, 'https://game.test', authorization)).status).toBe(401)
})

test('Bearer 无效或已撤销时不降级使用 Cookie，错误来源仍被拒绝', async () => {
  const f = await fixture()
  const clientNonce = 'a'.repeat(64)
  const tx = await f.http('/api/kook/login/start', '', { clientNonce })
  const result = await f.http('/api/kook/login/complete', '', {
    state: tx.data.state,
    code: f.oauth.issue('alice'),
    clientNonce,
  })
  const authorization = `Bearer ${result.data.gameToken}`
  for (const invalid of ['Bearer invalid', `Bearer ${'0'.repeat(64)}`, 'Basic something']) {
    expect((await f.http('/api/session', result.cookie, undefined, 'https://game.test', invalid)).status).toBe(401)
  }
  expect((await f.http('/api/rooms', '', {}, 'https://evil.test', authorization)).status).toBe(403)
  expect((await f.http('/api/session', result.cookie)).status).toBe(200)
})

test('nonce 事务同时绑定请求来源，允许列表中的其它来源也不能消费该事务', async () => {
  const f = await fixture(['https://game.test', 'https://other.game.test'])
  const clientNonce = 'a'.repeat(64)
  const tx = await f.http('/api/kook/login/start', '', { clientNonce })
  const input = { state: tx.data.state, clientNonce, code: f.oauth.issue('alice') }
  expect((await f.http('/api/kook/login/complete', '', input, 'https://other.game.test')).status).toBe(401)
  expect(f.oauth.exchanges()).toBe(0)
  expect((await f.http('/api/kook/login/complete', '', input)).status).toBe(200)
})

test('无 Cookie 的取消请求可撤销在途及已签发会话，错误 nonce 不能取消别人的事务', async () => {
  const f = await fixture()
  const clientNonce = 'a'.repeat(64)
  const tx = await f.http('/api/kook/login/start', '', { clientNonce })
  f.oauth.setDelay(150)
  const pending = f.http('/api/kook/login/complete', '', {
    state: tx.data.state,
    code: f.oauth.issue('alice'),
    clientNonce,
  })
  await expect.poll(f.oauth.exchanges).toBe(1)
  await f.http('/api/kook/login/cancel', '', { state: tx.data.state, clientNonce: 'b'.repeat(64) })
  await f.http('/api/kook/login/cancel', '', { state: tx.data.state, clientNonce })
  const cancelled = await pending
  expect(cancelled.status).toBe(401)
  expect(cancelled.data.gameToken).toBeUndefined()
  f.oauth.setDelay(0)
  const next = await f.http('/api/kook/login/start', '', { clientNonce })
  const result = await f.http('/api/kook/login/complete', '', {
    state: next.data.state,
    code: f.oauth.issue('alice'),
    clientNonce,
  })
  expect(result.status).toBe(200)
  await f.http('/api/kook/login/cancel', '', { state: next.data.state, clientNonce })
  expect(
    (await f.http('/api/session', '', undefined, 'https://game.test', `Bearer ${result.data.gameToken}`)).status
  ).toBe(401)
})

test('旧 Cookie 协议仍可登录，不能使用 nonce 绕过原 Cookie 事务绑定', async () => {
  const f = await fixture()
  const tx = await f.start()
  const payload = { state: tx.data.state, code: f.oauth.issue('alice') }
  expect(
    (await f.http('/api/kook/login/complete', tx.cookie, { ...payload, clientNonce: 'a'.repeat(64) })).status
  ).toBe(401)
  const result = await f.http('/api/kook/login/complete', tx.cookie, payload)
  expect(result.status).toBe(200)
  expect((await f.http('/api/session', result.cookie)).status).toBe(200)
})
