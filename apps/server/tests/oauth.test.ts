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

async function fixture() {
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
    devFaults: false,
    allowedOrigins: ['https://game.test'],
    kook: oauth.config,
  }
  const { app } = await createApp(config, repo)
  cleanups.push(() => app.close())
  async function http(path: string, cookie = '', body?: unknown, origin = 'https://game.test') {
    const response = await app.inject({
      method: body === undefined ? 'GET' : 'POST',
      url: path,
      headers: { origin, cookie, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    })
    const cookies = response.headers['set-cookie'] ?? []
    const list = Array.isArray(cookies) ? cookies : [cookies]
    return {
      status: response.statusCode,
      data: response.json(),
      cookie: list.map((value) => value.split(';')[0]).join('; '),
      headers: list.join(';'),
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
  return { http, start, login, oauth, repo }
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
