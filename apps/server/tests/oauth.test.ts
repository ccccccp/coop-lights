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
    logAccessKey: 'test-log-access-key',
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
      ...(body === undefined
        ? {}
        : {
            payload: JSON.stringify(
              path === '/api/kook/login/complete'
                ? { instanceId: 'fixture-instance', ...(body as Record<string, unknown>) }
                : body
            ),
          }),
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
  return { http, start, login, oauth, repo, app, admin }
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
  expect(result.data.user.avatarUrl).toBe('https://avatars.test/alice.svg')
  expect(JSON.stringify(result.data)).not.toMatch(/access_token|refresh_token|client_secret|openCode|appId/)
  expect((await f.http('/api/session', result.cookie)).status).toBe(200)
  expect((await f.http('/api/kook/login/complete', transaction.cookie, payload)).status).toBe(401)
  expect(f.oauth.exchanges()).toBe(1)
  expect((await f.http('/api/rooms', result.cookie, {})).data.room.platformInstanceId).toBe('fixture-instance')
})

test('排行榜读取持久化成绩并正确排序、并列，隔离独立模式及其他应用，使用最新KOOK头像昵称', async () => {
  const f = await fixture()
  expect((await f.http('/api/leaderboard')).status).toBe(401)
  const { result } = await f.login()
  const a = await f.repo.getUser(result.data.user.id)
  const b = await f.repo.upsertUser({
    appId: a!.appId,
    openCode: 'bob',
    nickname: '小林',
    avatarUrl: 'https://avatars.test/bob.svg',
  })
  const c = await f.repo.upsertUser({ appId: a!.appId, openCode: 'carol', nickname: '小月', avatarUrl: null })
  const local = await f.repo.upsertUser({ appId: 'standalone', openCode: 'local', nickname: '独立玩家' })
  const foreign = await f.repo.upsertUser({ appId: 'other-app', openCode: 'foreign', nickname: '其他应用玩家' })
  await f.repo.upsertUser({ appId: a!.appId, openCode: 'new', nickname: '尚未通关玩家' })
  expect((await f.http('/api/leaderboard', result.cookie)).data.items).toEqual([])
  const first = {
    roundId: randomUUID(),
    roomId: 'ABC234',
    finishedAt: Date.now(),
    moves: 5,
    contributions: { [a!.id]: 1, [b.id]: 1, [c.id]: 1, [local.id]: 1, [foreign.id]: 1 },
  }
  await f.repo.settle(first)
  await f.repo.settle(first)
  await f.repo.settle({ ...first, roundId: randomUUID() })
  await f.repo.settle({ ...first, roundId: randomUUID(), contributions: { [b.id]: 1 } })
  const response = await f.http('/api/leaderboard', result.cookie)
  expect(response.status).toBe(200)
  expect(response.cacheControl).toBe('no-store')
  expect(
    response.data.items.map((entry: { nickname: string; rank: number; completedRounds: number }) => [
      entry.nickname,
      entry.rank,
      entry.completedRounds,
    ])
  ).toEqual([['小林', 1, 3], ...[a!, c].sort((x, y) => x.id.localeCompare(y.id)).map((u) => [u.nickname, 2, 2])])
  expect(JSON.stringify(response.data)).not.toMatch(/openCode|open_code|appId|app_id|access_token|totalMoves/)
  expect(response.data.items[0].avatarUrl).toBe('https://avatars.test/bob.svg')
  expect(response.data.updatedAt).toBeGreaterThan(0)
  await f.repo.upsertUser({
    appId: a!.appId,
    openCode: 'bob',
    nickname: '更新后的小林',
    avatarUrl: 'https://avatars.test/new.svg',
  })
  expect((await f.http('/api/leaderboard', result.cookie)).data.items[0]).toMatchObject({
    nickname: '更新后的小林',
    avatarUrl: 'https://avatars.test/new.svg',
    completedRounds: 3,
  })
})

test('排行榜最多返回100位已通关玩家', async () => {
  const f = await fixture()
  const { result } = await f.login()
  await f.admin.query(
    `INSERT INTO lights_users (id, app_id, open_code, nickname, completed_rounds)
    SELECT gen_random_uuid(), $1, 'rank-' || n, '玩家' || n, n FROM generate_series(1, 102) AS n`,
    ['lights-sdk-fixture']
  )
  const response = await f.http('/api/leaderboard', result.cookie)
  expect(response.data.items).toHaveLength(100)
  expect(response.data.items[0]).toMatchObject({ rank: 1, completedRounds: 102 })
  expect(response.data.items[99]).toMatchObject({ rank: 100, completedRounds: 3 })
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
  expect(failed.data.code).toBe('PLATFORM_LOGIN_FAILED')
  expect(failed.data.details).toEqual({
    stage: 'token',
    endpoint: f.oauth.config.tokenUrl,
    http_status: 400,
    upstream_code: 'invalid_grant',
  })
  expect(failed.data.message).toContain('invalid_grant')
  expect(JSON.stringify(failed.data)).not.toContain('unknown-code')
  expect(JSON.stringify(failed.data)).not.toContain(f.oauth.config.clientSecret)
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

test('OAuth 用户名和头像持久化并进入同一房间快照，重新授权刷新资料且不改变用户和房间', async () => {
  const f = await fixture()
  const a = (await f.login()).result
  const room = await f.http('/api/rooms', a.cookie, {})
  expect(room.status).toBe(200)
  const tx = await f.start()
  const b = await f.http('/api/kook/login/complete', tx.cookie, { state: tx.data.state, code: f.oauth.issue('bob') })
  const joined = await f.http(`/api/rooms/${room.data.room.id}/join`, b.cookie, {})
  expect(
    joined.data.room.players.map((player: { nickname: string; avatarUrl: string }) => [
      player.nickname,
      player.avatarUrl,
    ])
  ).toEqual([
    ['模拟玩家阿青', 'https://avatars.test/alice.svg'],
    ['模拟玩家小林', 'https://avatars.test/bob.svg'],
  ])
  expect((await f.repo.getUser(b.data.user.id))?.avatarUrl).toBe('https://avatars.test/bob.svg')
  f.oauth.setProfile('bob', { username: '小林的新名字', avatar: 'https://avatars.test/bob-new.svg' })
  const next = await f.start()
  const updated = await f.http('/api/kook/login/complete', `${next.cookie}; ${b.cookie}`, {
    state: next.data.state,
    code: f.oauth.issue('bob'),
  })
  expect(updated.data.user.id).toBe(b.data.user.id)
  expect(updated.data.room.id).toBe(room.data.room.id)
  const state = await f.http('/api/session', a.cookie)
  expect(state.data.room.players.find((player: { id: string }) => player.id === b.data.user.id)).toMatchObject({
    nickname: '小林的新名字',
    avatarUrl: 'https://avatars.test/bob-new.svg',
  })
})

test('头像缺失或地址不安全时仍能登录并使用空头像，不信任客户端伪造的用户资料', async () => {
  const f = await fixture()
  for (const avatar of [
    '',
    'javascript:alert(1)',
    'http://avatars.test/a.png',
    'https://name:secret@avatars.test/a.png',
    'x'.repeat(2049),
  ]) {
    f.oauth.setProfile('alice', { avatar })
    const result = (await f.login()).result
    expect(result.status).toBe(200)
    expect(result.data.user.avatarUrl).toBeNull()
  }
  const tx = await f.start()
  const forged = await f.http('/api/kook/login/complete', tx.cookie, {
    state: tx.data.state,
    code: f.oauth.issue('alice'),
    nickname: '伪造名字',
    avatarUrl: 'https://avatars.test/forged.svg',
  })
  expect(forged.status).toBe(400)
})

test('旧数据库幂等增加头像列，更新头像不改变用户标识和累计成绩', async () => {
  const f = await fixture()
  await f.admin.query('ALTER TABLE lights_users DROP COLUMN avatar_url')
  const id = randomUUID()
  await f.admin.query(
    'INSERT INTO lights_users(id,app_id,open_code,nickname,completed_rounds,total_moves) VALUES($1,$2,$3,$4,7,42)',
    [id, 'existing-app', 'existing-open-code', '旧名字']
  )
  const migration = await readFile(resolve(projectRoot, 'db/migrations/001_initial.sql'), 'utf8')
  await f.admin.query(migration)
  await f.admin.query(migration)
  expect(await f.repo.getUser(id)).toMatchObject({ id, avatarUrl: null, completedRounds: 7, totalMoves: 42 })
  const updated = await f.repo.upsertUser({
    appId: 'existing-app',
    openCode: 'existing-open-code',
    nickname: 'KOOK 新名字',
    avatarUrl: 'https://avatars.test/a.svg',
  })
  expect(updated).toMatchObject({
    id,
    nickname: 'KOOK 新名字',
    avatarUrl: 'https://avatars.test/a.svg',
    completedRounds: 7,
    totalMoves: 42,
  })
})

test('普通登录不调用context，实例接口异常也保留用户身份和主页', async () => {
  const f = await fixture()
  f.oauth.setContextResponse({ unexpected: true })
  const { result } = await f.login()
  expect(result.status).toBe(200)
  expect(result.data.user.nickname).toBe('模拟玩家阿青')
  expect(result.data.platform.invitedRoomId).toBeNull()
  expect(f.oauth.contextCalls()).toBe(0)
  expect((await f.http('/api/rooms', result.cookie, {})).status).toBe(502)
  expect((await f.http('/api/session', result.cookie)).status).toBe(200)
})

test('大厅按服务端context准入，伪造上下文或裸roomId不能跨频道，可信邀请可直接入房', async () => {
  const f = await fixture()
  async function login(player: 'alice' | 'bob', context: { type: 1 | 2; id: string }, roomId: string | null = null) {
    const tx = await f.start()
    return f.http('/api/kook/login/complete', tx.cookie, {
      state: tx.data.state,
      code: f.oauth.issue(player, roomId, 'fixture-instance', context),
    })
  }
  const a = await login('alice', { type: 1, id: 'text-channel' })
  const b = await login('bob', { type: 2, id: 'voice-channel' })
  const created = await f.http('/api/rooms', a.cookie, { context: { type: 2, id: 'forged' } })
  expect(created.status).toBe(200)
  expect(created.data.room.context).toEqual({ type: 1, id: 'text-channel' })
  const id = created.data.room.id
  const lobby = await f.http('/api/lobby', b.cookie)
  expect(lobby.data.context).toEqual({ type: 2, id: 'voice-channel' })
  expect(lobby.data.rooms[0]).toMatchObject({ id, isCurrentContext: false, canJoin: false })
  expect(lobby.data.canCreate).toBe(true)
  expect((await f.http(`/api/rooms/${id}/join`, b.cookie, { context: { type: 1, id: 'text-channel' } })).status).toBe(
    403
  )
  expect((await f.http('/api/rooms', a.cookie, {})).data.code).toBe('ALREADY_IN_ROOM')
  const invited = await login('bob', { type: 2, id: 'voice-channel' }, id)
  expect((await f.http(`/api/rooms/${id}/join`, invited.cookie, {})).data.room.players).toHaveLength(2)
})

test('邀请核验单独读取room_id，失败保留原登录，成功返回可信房间', async () => {
  const f = await fixture()
  const tx = await f.start()
  const login = await f.http('/api/kook/login/complete', tx.cookie, {
    state: tx.data.state,
    code: f.oauth.issue('alice', 'ABC234'),
  })
  f.oauth.setContextResponse({ unexpected: true })
  const failed = await f.http('/api/kook/invite/resolve', login.cookie, { instanceId: 'fixture-instance' })
  expect(failed.status).toBe(502)
  expect((await f.http('/api/session', login.cookie)).status).toBe(200)
  f.oauth.setContextResponse(undefined)
  const resolved = await f.http('/api/kook/invite/resolve', login.cookie, { instanceId: 'fixture-instance' })
  expect(resolved.status).toBe(200)
  expect(resolved.data).toEqual({
    instanceId: 'fixture-instance',
    context: { type: 4, id: 'fixture-chat' },
    invitedRoomId: 'ABC234',
  })
  expect(JSON.stringify(resolved.data)).not.toMatch(/accessToken|access_token|client_secret/)
})

test('邀请未登录、非法房间自报和错误实例均不能核验，不损坏已登录会话', async () => {
  const f = await fixture(),
    { result } = await f.login()
  expect((await f.http('/api/kook/invite/resolve', '', { instanceId: 'fixture-instance' })).status).toBe(401)
  expect(
    (await f.http('/api/kook/invite/resolve', result.cookie, { instanceId: 'fixture-instance', room_id: 'FAKE22' }))
      .status
  ).toBe(400)
  expect((await f.http('/api/kook/invite/resolve', result.cookie, { instanceId: 'foreign' })).status).toBe(502)
  expect((await f.http('/api/session', result.cookie)).status).toBe(200)
})

test('注销中的context回包不能恢复旧会话或自动入房', async () => {
  const f = await fixture(),
    { result } = await f.login()
  f.oauth.setContextDelay(100)
  const pending = f.http('/api/kook/invite/resolve', result.cookie, { instanceId: 'fixture-instance' })
  await expect.poll(f.oauth.contextCalls).toBe(1)
  await f.http('/api/logout', result.cookie, {})
  expect((await pending).status).toBe(401)
})

test('日志记录OAuth入参、脱敏响应和状态，访问密钥保护，查询不写入自身日志', async () => {
  const f = await fixture()
  const { result } = await f.login()
  expect(result.status).toBe(200)
  expect((await f.http('/api/logs')).status).toBe(401)
  const logs = await f.app.inject({ url: '/api/logs?kind=kook', headers: { 'x-log-key': 'test-log-access-key' } })
  expect(logs.statusCode).toBe(200)
  const items = logs.json().items
  expect(items.length).toBe(2)
  expect(items.map((item: { stage: string }) => item.stage)).toEqual(['userinfo', 'token'])
  expect(items[1].request.body.code).toBe('[REDACTED]')
  expect(items[1].request.body.client_secret).toBe('[REDACTED]')
  expect(items[1].response.access_token).toBe('[REDACTED]')
  expect(items[0].status).toBe(200)
  expect(items[0].durationMs).toBeGreaterThanOrEqual(0)
  expect(JSON.stringify(items)).not.toContain(f.oauth.config.clientSecret)
})

test('日志默认最近3天倒序排列，支持稳定分页、KOOK筛选、失败筛选和时间范围', async () => {
  const f = await fixture(),
    now = Date.now()
  async function add(startedAt: number, kind: 'game' | 'kook', ok: boolean, endpoint: string) {
    await f.repo.saveCallLog({
      requestId: randomUUID(),
      kind,
      method: 'GET',
      endpoint,
      startedAt,
      durationMs: 10,
      status: ok ? 200 : 502,
      ok,
      request: { query: { instance_id: 'one' } },
      response: { code: ok ? 0 : 'FAILED' },
    })
  }
  await add(now - 4 * 86400000, 'kook', true, '/old')
  await add(now - 1000, 'kook', false, '/context')
  await add(now - 500, 'game', true, '/session')
  await add(now - 100, 'kook', true, '/userinfo')
  const query = async (q = '') => {
    const r = await f.app.inject({
      url: '/api/logs' + (q ? '?' + q : ''),
      headers: { 'x-log-key': 'test-log-access-key' },
    })
    expect(r.statusCode).toBe(200)
    return r.json()
  }
  const first = await query('limit=2')
  expect(first.items.map((e: { endpoint: string }) => e.endpoint)).toEqual(['/userinfo', '/session'])
  expect(first.to - first.from).toBe(3 * 86400000)
  const p = first.nextCursor
  const next = await query('limit=2&cursorTime=' + p.startedAt + '&cursorId=' + p.id)
  expect(next.items.map((e: { endpoint: string }) => e.endpoint)).toEqual(['/context'])
  expect((await query('kind=kook&errors=true')).items.map((e: { endpoint: string }) => e.endpoint)).toEqual([
    '/context',
  ])
  const from = new Date(now - 5 * 86400000).toISOString(),
    to = new Date(now - 3 * 86400000).toISOString()
  expect(
    (await query('from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to))).items.map(
      (e: { endpoint: string }) => e.endpoint
    )
  ).toEqual(['/old'])
  expect((await query('search=userinfo')).items.length).toBe(1)
})
