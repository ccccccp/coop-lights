import { afterEach, describe, expect, test } from 'vitest'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import pg from 'pg'
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import { createApp } from '../src/app'
import { PostgresRepository } from '../src/storage'
import { generateBoard, solve, toggle } from '../src/board'
import { getConfig, projectRoot, type Config } from '../src/config'
import type { Command, RoomSnapshot, ServerEvent } from '@lights/contracts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function fixture(overrides: Partial<Config> = {}) {
  const baseConfig = getConfig(),
    schema = `lights_test_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Client({ connectionString: baseConfig.databaseUrl })
  await admin.connect()
  cleanups.push(async () => {
    await admin.query(`DROP SCHEMA ${schema} CASCADE`)
    await admin.end()
  })
  await admin.query(`CREATE SCHEMA ${schema}`)
  await admin.query(`SET search_path TO ${schema}`)
  await admin.query(await readFile(resolve(projectRoot, 'db/migrations/001_initial.sql'), 'utf8'))
  const repo = await new PostgresRepository(baseConfig.databaseUrl, schema).init()
  const config: Config = {
    ...baseConfig,
    mode: 'standalone',
    host: '127.0.0.1',
    port: 0,
    maxPlayers: 4,
    graceMs: 200,
    sessionTtlMs: 60000,
    devFaults: true,
    allowedOrigins: ['http://lights.test'],
    ...overrides,
  }
  const { app, rooms } = await createApp(config, repo)
  await app.listen({ port: 0, host: '127.0.0.1' })
  cleanups.push(() => app.close())
  const address = app.server.address() as { port: number }
  async function http(path: string, cookie = '', body?: unknown, origin = 'http://lights.test') {
    const res = await app.inject({
      method: body === undefined ? 'GET' : 'POST',
      url: path,
      headers: { cookie, origin, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    })
    return {
      status: res.statusCode,
      data: res.json(),
      cookie: String(res.headers['set-cookie'] ?? '').split(';')[0],
    }
  }
  async function login(name: string) {
    return http('/api/dev/session', '', { nickname: name })
  }
  async function connect(cookie: string) {
    const { data } = await http('/api/ws-tickets', cookie, {})
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
      headers: { origin: 'http://lights.test' },
    })
    const events: ServerEvent[] = []
    ws.on('message', (data) => events.push(JSON.parse(data.toString())))
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    ws.send(JSON.stringify({ type: 'authenticate', ticket: data.ticket }))
    await waitFor(() => events.some((e) => e.type === 'connected'))
    cleanups.push(async () => {
      ws.terminate()
    })
    return {
      ws,
      events,
      command: async (c: Command) => {
        ws.send(JSON.stringify(c))
        await waitFor(() =>
          events.some((e) => e.type === 'command.result' && e.actionId === c.actionId),
        )
        return events.find(
          (e) => e.type === 'command.result' && e.actionId === c.actionId,
        ) as Extract<ServerEvent, { type: 'command.result' }>
      },
    }
  }
  return { app, rooms, repo, http, login, connect, schema }
}
async function waitFor(fn: () => boolean, timeout = 3000) {
  const deadline = Date.now() + timeout
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('等待实际协议事件超时')
    await new Promise((r) => setTimeout(r, 10))
  }
}
const cmd = (roomId: string, fields: Record<string, unknown>) =>
  ({ roomId, actionId: randomUUID(), ...fields }) as Command
async function startedGame() {
  const f = await fixture(),
    a = await f.login('阿青'),
    b = await f.login('小林')
  const ca = await f.connect(a.cookie),
    cb = await f.connect(b.cookie)
  const created = await f.http('/api/rooms', a.cookie, {}),
    id = created.data.room.id as string
  await f.http(`/api/rooms/${id}/join`, b.cookie, {})
  await ca.command(cmd(id, { type: 'room.ready', ready: true }))
  await cb.command(cmd(id, { type: 'room.ready', ready: true }))
  expect((await ca.command(cmd(id, { type: 'round.start', seed: 42 }))).ok).toBe(true)
  return { ...f, a, b, ca, cb, id }
}

describe('灯阵与关卡', () => {
  test('边界不串行，点击两次可还原', () => {
    const initial = Array<boolean>(16).fill(true),
      next = toggle(initial, 0)
    expect(next.flatMap((on, i) => (on ? [] : [i]))).toEqual([0, 1, 4])
    expect(toggle(next, 0)).toEqual(initial)
    expect(initial.every(Boolean)).toBe(true)
  })
  test('生成关卡不是完成态，解法可以还原', () => {
    for (const seed of [0, 1, 42, 999, 0xffffffff]) {
      const { board, solution } = generateBoard(seed)
      expect(board.every(Boolean)).toBe(false)
      expect(solution.reduce(toggle, board).every(Boolean)).toBe(true)
      expect(solve(board).reduce(toggle, board).every(Boolean)).toBe(true)
    }
  })
})

describe('真实 HTTP 与 WebSocket', () => {
  test('未登录、错误来源、真实平台未配置时不放行本地身份', async () => {
    const f = await fixture()
    expect((await f.http('/api/session')).status).toBe(401)
    expect(
      (await f.http('/api/dev/session', '', { nickname: '测试' }, 'http://evil.test')).status,
    ).toBe(403)
    expect((await f.http('/api/dev/session', '', { nickname: '   ' })).status).toBe(400)
    const platform = await fixture({ mode: 'kook' })
    expect((await platform.login('不得伪造')).data.code).toBe('PLATFORM_NOT_CONFIGURED')
  })
  test('两人协作通关，记录只结算一次且可从 PostgreSQL 新连接读取', async () => {
    const f = await startedGame()
    const cells = solve(f.rooms.snapshot(f.id)!.round!.board)
    for (let i = 0; i < cells.length; i++) {
      const s = f.rooms.snapshot(f.id)!
      const result = await (i % 2 ? f.cb : f.ca).command(
        cmd(f.id, {
          type: 'board.toggle',
          roundId: s.round!.id,
          expectedVersion: s.version,
          cell: cells[i],
        }),
      )
      expect(result.ok).toBe(true)
    }
    const s = f.rooms.snapshot(f.id)!
    expect(s.status).toBe('finished')
    expect(s.round!.saveState).toBe('saved')
    expect((await f.http('/api/session', f.a.cookie)).data.user.completedRounds).toBe(1)
    expect((await f.http('/api/session', f.b.cookie)).data.user.completedRounds).toBe(1)
    const blocked = await f.ca.command(
      cmd(f.id, {
        type: 'board.toggle',
        roundId: s.round!.id,
        expectedVersion: s.version,
        cell: 0,
      }),
    )
    expect(blocked.error?.code).toBe('ROUND_NOT_ACTIVE')
    const reload = await new PostgresRepository(getConfig().databaseUrl, f.schema).init()
    cleanups.push(() => reload.close())
    expect((await reload.getUser(f.a.data.user.id))!.completedRounds).toBe(1)
  })
  test('并发版本冲突明确拒绝，同一 actionId 不重复操作', async () => {
    const f = await startedGame(),
      s = f.rooms.snapshot(f.id)!
    const first = cmd(f.id, {
      type: 'board.toggle',
      roundId: s.round!.id,
      expectedVersion: s.version,
      cell: 0,
    })
    const second = cmd(f.id, {
      type: 'board.toggle',
      roundId: s.round!.id,
      expectedVersion: s.version,
      cell: 1,
    })
    const results = await Promise.all([f.ca.command(first), f.cb.command(second)])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.find((r) => !r.ok)?.error?.code).toBe('VERSION_STALE')
    expect(f.rooms.snapshot(f.id)!.round!.moves).toBe(1)
    const success = results[0].ok ? first : second,
      client = results[0].ok ? f.ca : f.cb
    const count = client.events.filter(
      (e) => e.type === 'command.result' && e.actionId === success.actionId,
    ).length
    client.ws.send(JSON.stringify(success))
    await waitFor(
      () =>
        client.events.filter((e) => e.type === 'command.result' && e.actionId === success.actionId)
          .length > count,
    )
    expect(f.rooms.snapshot(f.id)!.round!.moves).toBe(1)
  })
  test('重连替代旧连接、中途加入、超时清理与房主转交', async () => {
    const f = await startedGame(),
      originalBoard = f.rooms.snapshot(f.id)!.round!.board
    const reconnected = await f.connect(f.a.cookie)
    await waitFor(() => f.ca.events.some((e) => e.type === 'session.replaced'))
    expect(f.rooms.snapshot(f.id)!.players.find((p) => p.id === f.a.data.user.id)?.online).toBe(
      true,
    )
    const third = await f.login('小雨'),
      cc = await f.connect(third.cookie)
    expect((await f.http(`/api/rooms/${f.id}/join`, third.cookie, {})).status).toBe(200)
    expect(f.rooms.snapshot(f.id)!.round!.board).toEqual(originalBoard)
    reconnected.ws.close()
    await waitFor(
      () =>
        f.rooms.snapshot(f.id)!.players.find((p) => p.id === f.a.data.user.id)?.online === false,
    )
    await waitFor(
      () =>
        (f.rooms.snapshot(f.id)!.players.find((p) => p.id === f.a.data.user.id)?.reconnectUntil ??
          Infinity) <= Date.now(),
    )
    await f.rooms.sweep()
    expect(f.rooms.snapshot(f.id)!.hostId).toBe(f.b.data.user.id)
    await f.http(`/api/rooms/${f.id}/leave`, f.b.cookie, {})
    expect(f.rooms.snapshot(f.id)!.hostId).toBe(third.data.user.id)
    await f.http(`/api/rooms/${f.id}/leave`, third.cookie, {})
    expect(f.rooms.snapshot(f.id)).toBeNull()
    cc.ws.close()
  })
  test('容量与房主操作检查，拒绝跨局操作，注销撤销会话', async () => {
    const f = await startedGame()
    expect((await f.cb.command(cmd(f.id, { type: 'round.start' }))).error?.code).toBe('HOST_ONLY')
    const s = f.rooms.snapshot(f.id)!
    expect(
      (
        await f.ca.command(
          cmd(f.id, {
            type: 'board.toggle',
            roundId: randomUUID(),
            expectedVersion: s.version,
            cell: 0,
          }),
        )
      ).error?.code,
    ).toBe('ROUND_CHANGED')
    for (let i = 0; i < 2; i++) {
      const p = await f.login(`玩家${i}`)
      expect((await f.http(`/api/rooms/${f.id}/join`, p.cookie, {})).status).toBe(200)
    }
    const fifth = await f.login('第五人')
    expect((await f.http(`/api/rooms/${f.id}/join`, fifth.cookie, {})).data.code).toBe('ROOM_FULL')
    await f.http('/api/logout', f.a.cookie, {})
    expect((await f.http('/api/session', f.a.cookie)).status).toBe(401)
  })
  test('超过恢复窗口后重连回到大厅，旧或无会话可以正常注销', async () => {
    const f = await fixture(),
      player = await f.login('恢复测试')
    const connection = await f.connect(player.cookie)
    const created = await f.http('/api/rooms', player.cookie, {})
    connection.ws.close()
    await waitFor(() => f.rooms.snapshot(created.data.room.id)?.players[0].online === false)
    await waitFor(
      () =>
        (f.rooms.snapshot(created.data.room.id)?.players[0].reconnectUntil ?? Infinity) <=
        Date.now(),
    )
    await f.rooms.sweep()
    const restored = await f.connect(player.cookie)
    const event = restored.events.find((e) => e.type === 'connected') as Extract<
      ServerEvent,
      { type: 'connected' }
    >
    expect(event.room).toBeNull()
    expect((await f.http('/api/logout', player.cookie, {})).status).toBe(200)
    expect((await f.http('/api/logout', player.cookie, {})).status).toBe(200)
    expect((await f.http('/api/logout', '', {})).status).toBe(200)
  })
})
