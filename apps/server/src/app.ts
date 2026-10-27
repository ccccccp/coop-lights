import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { resolve } from 'node:path'
import type { Duplex } from 'node:stream'

import Fastify, { type FastifyRequest } from 'fastify'
import { WebSocket, WebSocketServer } from 'ws'
import { z } from 'zod'

import cookie from '@fastify/cookie'
import staticFiles from '@fastify/static'
import {
  type GameUser,
  PROTOCOL_VERSION,
  type ServerEvent,
  commandSchema,
  nicknameSchema,
  roomIdSchema,
} from '@lights/contracts'

import type { Config } from './config'
import { GameError, check } from './errors'
import { LoginTransactions, exchangeKookCode, isOAuthConfigured, platformContext } from './platform'
import { Rooms } from './rooms'
import type { Repository, Session } from './storage'

function hash(token: string) {
  return createHash('sha256').update(token).digest('hex')
}
function publicUser(u: GameUser) {
  return {
    id: u.id,
    nickname: u.nickname,
    completedRounds: u.completedRounds,
    totalMoves: u.totalMoves,
  }
}
export async function createApp(config: Config, repo: Repository, staticRoot?: string) {
  const app = Fastify({
    bodyLimit: 8192,
    logger: {
      level: 'warn',
      redact: ['req.headers.cookie', 'req.headers.authorization'],
    },
  })
  await app.register(cookie)
  const clients = new Map<string, { ws: WebSocket; id: string; session: Session; alive: boolean }>()
  const tickets = new Map<string, { session: Session; expiresAt: number }>()
  const transactions = new LoginTransactions()
  const cookieOptions = {
    path: '/',
    httpOnly: true,
    sameSite: config.mode === 'kook' ? ('none' as const) : ('strict' as const),
    secure: config.mode === 'kook',
    ...(config.mode === 'kook' ? { partitioned: true } : {}),
  }
  function send(ws: WebSocket, event: ServerEvent) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event))
  }
  const rooms = new Rooms(repo, config.maxPlayers, config.graceMs, (id, event) => {
    for (const [uid, c] of clients) if (rooms.forUser(uid)?.id === id) send(c.ws, event)
  })
  async function auth(req: FastifyRequest) {
    const token = req.cookies.lights_session
    const session = token ? await repo.getSession(hash(token)) : null
    check(session, 'UNAUTHENTICATED', '请先进入游戏', 401)
    const user = await repo.getUser(session.userId)
    check(user, 'UNAUTHENTICATED', '登录已失效，请重新进入', 401)
    check(
      config.mode === 'standalone'
        ? user.appId === 'standalone'
        : isOAuthConfigured(config.kook) && user.appId === config.kook.clientId,
      'UNAUTHENTICATED',
      '登录不属于当前游戏模式或应用，请重新登录',
      401
    )
    return { session, user }
  }
  app.addHook('onRequest', async (req) => {
    const origin = req.headers.origin
    if (req.method !== 'GET' && req.method !== 'HEAD')
      check(origin && config.allowedOrigins.includes(origin), 'ORIGIN_DENIED', '请求来源不允许', 403)
  })
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof GameError)
      return reply.code(error.statusCode).send({ code: error.code, message: error.message })
    if ((error instanceof Error && error.name === 'ZodError') || (error as { statusCode?: number })?.statusCode === 400)
      return reply.code(400).send({
        code: 'INVALID_INPUT',
        message: '输入内容不合法，请检查后重试',
      })
    app.log.error({ err: error, path: req.url.split('?')[0] }, 'request failed')
    return reply.code(500).send({ code: 'INTERNAL_ERROR', message: '服务暂不可用，请重试' })
  })
  app.get('/api/health', async () => ({
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    storage: repo.kind,
    platform: platformContext(config.mode),
    reconnectGraceMs: config.graceMs,
    devTools: config.devFaults,
    oauthConfigured: config.mode === 'kook' && isOAuthConfigured(config.kook),
  }))
  function requireKook() {
    check(
      config.mode === 'kook' && isOAuthConfigured(config.kook),
      'PLATFORM_NOT_CONFIGURED',
      '游戏服务端尚未配置 KOOK OAuth',
      503
    )
  }
  async function revokeSession(sessionHash: string) {
    const session = await repo.getSession(sessionHash)
    if (session) {
      const active = clients.get(session.userId)
      if (active?.session.hash === sessionHash) active.ws.close(4001, 'logged out')
      // An old login response must not remove a newer session's player from its room.
      if (!active || active.session.hash === sessionHash) {
        const room = rooms.forUser(session.userId)
        if (room) await rooms.leave(room.id, session.userId)
      }
      await repo.deleteSession(sessionHash)
    }
  }
  app.post('/api/kook/login/start', async (req, reply) => {
    requireKook()
    const existing = req.cookies.lights_oauth
    const browser = existing && /^[a-f0-9]{64}$/.test(existing) ? existing : randomBytes(32).toString('hex')
    const state = transactions.begin(hash(browser))
    reply.header('Cache-Control', 'no-store').setCookie('lights_oauth', browser, { ...cookieOptions, maxAge: 300 })
    return { state }
  })
  app.post('/api/kook/login/complete', async (req, reply) => {
    requireKook()
    const input = z
      .object({ state: z.string().regex(/^[a-f0-9]{64}$/), code: z.string().min(1).max(4096).regex(/^\S+$/) })
      .strict()
      .parse(req.body)
    const transaction = transactions.consume(input.state, hash(req.cookies.lights_oauth ?? ''))
    const grant = await exchangeKookCode(config.kook, input.code)
    transactions.assertActive(transaction)
    const user = await repo.upsertUser(grant.identity)
    transactions.assertActive(transaction)
    const token = randomBytes(32).toString('hex')
    const session: Session = {
      hash: hash(token),
      userId: user.id,
      expiresAt: Math.min(Date.now() + config.sessionTtlMs, grant.expiresAt),
      instanceId: null,
    }
    // ready().instanceId is display metadata, never a game-server authorization credential.
    await repo.saveSession(session)
    transaction.sessionHash = session.hash
    if (transaction.cancelled || transaction.expiresAt <= Date.now()) {
      await repo.deleteSession(session.hash)
      transactions.assertActive(transaction)
    }
    const oldToken = req.cookies.lights_session
    const old = oldToken ? await repo.getSession(hash(oldToken)) : null
    if (old) {
      if (old.userId !== user.id) await revokeSession(old.hash)
      else {
        await repo.deleteSession(old.hash)
        const active = clients.get(user.id)
        if (active?.session.hash === old.hash) active.ws.close(4001, 'session renewed')
      }
    }
    transactions.assertActive(transaction)
    reply.header('Cache-Control', 'no-store').setCookie('lights_session', token, {
      ...cookieOptions,
      maxAge: Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000)),
    })
    return { user: publicUser(user), room: rooms.forUser(user.id), platform: platformContext(config.mode) }
  })
  app.post('/api/kook/login/cancel', async (req) => {
    const { state } = z
      .object({ state: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .parse(req.body)
    for (const session of transactions.cancel(hash(req.cookies.lights_oauth ?? ''), state)) await revokeSession(session)
    return { ok: true }
  })
  app.post('/api/dev/session', async (req, reply) => {
    check(config.mode === 'standalone', 'PLATFORM_NOT_CONFIGURED', '真实 KOOK 模式尚未配置，不接受本地登录', 503)
    const nickname = nicknameSchema.parse((req.body as { nickname?: unknown })?.nickname)
    const old = req.cookies.lights_session ? await repo.getSession(hash(req.cookies.lights_session)) : null
    if (old) {
      const user = await repo.getUser(old.userId)
      if (user?.appId === 'standalone')
        return {
          user: publicUser(user),
          room: rooms.forUser(user.id),
          platform: platformContext(config.mode),
        }
    }
    const user = await repo.upsertUser({
      appId: 'standalone',
      openCode: randomUUID(),
      nickname,
    })
    const token = randomBytes(32).toString('hex')
    const session: Session = {
      hash: hash(token),
      userId: user.id,
      expiresAt: Date.now() + config.sessionTtlMs,
      instanceId: null,
    }
    await repo.saveSession(session)
    reply.setCookie('lights_session', token, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: req.protocol === 'https',
      maxAge: Math.floor(config.sessionTtlMs / 1000),
    })
    return {
      user: publicUser(user),
      room: null,
      platform: platformContext(config.mode),
    }
  })
  app.get('/api/session', async (req) => {
    const { user } = await auth(req)
    return {
      user: publicUser(user),
      room: rooms.forUser(user.id),
      platform: platformContext(config.mode),
    }
  })
  app.post('/api/logout', async (req, reply) => {
    if (req.cookies.lights_session) await revokeSession(hash(req.cookies.lights_session))
    for (const session of transactions.cancel(hash(req.cookies.lights_oauth ?? ''))) await revokeSession(session)
    reply.clearCookie('lights_session', cookieOptions)
    reply.clearCookie('lights_oauth', cookieOptions)
    return { ok: true }
  })
  app.post('/api/rooms', async (req) => {
    const { user, session } = await auth(req)
    const room = rooms.create(user, session.instanceId),
      c = clients.get(user.id)
    if (c) rooms.connect(user.id, c.id)
    return { room: rooms.snapshot(room.id) }
  })
  app.post<{ Params: { id: string } }>('/api/rooms/:id/join', async (req) => {
    const { user, session } = await auth(req)
    const id = roomIdSchema.parse(req.params.id),
      room = await rooms.join(id, user, session.instanceId),
      c = clients.get(user.id)
    if (c) rooms.connect(user.id, c.id)
    return { room: rooms.snapshot(room.id) }
  })
  app.post<{ Params: { id: string } }>('/api/rooms/:id/leave', async (req) => {
    const { user } = await auth(req)
    await rooms.leave(roomIdSchema.parse(req.params.id), user.id)
    return { ok: true }
  })
  app.get<{ Params: { id: string } }>('/api/rooms/:id/hint', async (req) => {
    const { user } = await auth(req)
    check(config.devFaults, 'DEV_DISABLED', '当前环境未启用开发提示', 404)
    return { cells: rooms.hint(roomIdSchema.parse(req.params.id), user.id) }
  })
  app.post('/api/ws-tickets', async (req) => {
    const { session } = await auth(req)
    check(tickets.size < 2000, 'TOO_MANY_REQUESTS', '连接请求过多，请稍后重试', 429)
    const ticket = randomBytes(24).toString('hex')
    tickets.set(ticket, { session, expiresAt: Date.now() + 10000 })
    return { ticket }
  })
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8192 })
  function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    if (req.url !== '/ws' || !req.headers.origin || !config.allowedOrigins.includes(req.headers.origin)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws))
  }
  app.server.on('upgrade', upgrade)
  wss.on('connection', (ws) => {
    let current: { userId: string; connectionId: string } | null = null,
      authenticating = false
    const timeout = setTimeout(() => ws.close(4003, 'authentication timeout'), 5000)
    let windowStart = Date.now(),
      count = 0
    ws.on('error', (e) => app.log.warn({ message: e.message }, 'websocket error'))
    ws.on('pong', () => {
      if (current) {
        const c = clients.get(current.userId)
        if (c?.id === current.connectionId) c.alive = true
      }
    })
    ws.on('message', async (raw) => {
      try {
        const data: unknown = JSON.parse(raw.toString())
        if (!current) {
          if (authenticating) return
          authenticating = true
          const token = data as { type?: string; ticket?: string }
          const entry =
            token.type === 'authenticate' && typeof token.ticket === 'string' ? tickets.get(token.ticket) : null
          if (token.ticket) tickets.delete(token.ticket)
          if (
            !entry ||
            entry.expiresAt <= Date.now() ||
            entry.session.expiresAt <= Date.now() ||
            !(await repo.getSession(entry.session.hash))
          ) {
            ws.close(4003, 'invalid ticket')
            return
          }
          if (ws.readyState !== WebSocket.OPEN) return
          const uid = entry.session.userId,
            id = randomUUID(),
            previous = clients.get(uid)
          current = { userId: uid, connectionId: id }
          clients.set(uid, { ws, id, session: entry.session, alive: true })
          rooms.connect(uid, id)
          if (previous) {
            send(previous.ws, { type: 'session.replaced' })
            previous.ws.close(4002, 'connection replaced')
          }
          clearTimeout(timeout)
          const room = rooms.forUser(uid)
          // 空快照也必须同步，清除超时退出或服务端重启后的旧房间页面。
          send(ws, { type: 'connected', protocolVersion: PROTOCOL_VERSION, room })
          return
        }
        const c = clients.get(current.userId)
        if (!c || c.id !== current.connectionId || c.session.expiresAt <= Date.now()) {
          ws.close(4001, 'session expired')
          return
        }
        if (Date.now() - windowStart >= 1000) {
          windowStart = Date.now()
          count = 0
        }
        if (++count > 30) {
          send(ws, {
            type: 'error',
            code: 'RATE_LIMITED',
            message: '操作太快，请稍后重试',
          })
          return
        }
        const parsed = commandSchema.safeParse(data)
        if (!parsed.success) {
          send(ws, {
            type: 'error',
            code: 'INVALID_COMMAND',
            message: '命令格式不合法',
          })
          return
        }
        send(ws, await rooms.handle(current.userId, current.connectionId, parsed.data, config.devFaults))
      } catch (e) {
        app.log.error({ err: e }, 'websocket command failed')
        send(ws, {
          type: 'error',
          code: 'COMMAND_FAILED',
          message: '操作未完成，请刷新状态后重试',
        })
      }
    })
    ws.on('close', () => {
      clearTimeout(timeout)
      if (!current) return
      const c = clients.get(current.userId)
      if (c?.id === current.connectionId) clients.delete(current.userId)
      rooms.disconnect(current.userId, current.connectionId)
    })
  })
  let lastPing = Date.now()
  const sweep = setInterval(() => {
    const now = Date.now()
    transactions.sweep()
    for (const [key, t] of tickets) if (t.expiresAt <= now) tickets.delete(key)
    for (const c of clients.values()) if (c.session.expiresAt <= now) c.ws.close(4001, 'session expired')
    if (now - lastPing >= 15000) {
      lastPing = now
      for (const c of clients.values()) {
        if (!c.alive) c.ws.terminate()
        else {
          c.alive = false
          c.ws.ping()
        }
      }
    }
    void rooms.sweep().catch((e) => app.log.error({ err: e }, 'room sweep failed'))
  }, 1000)
  sweep.unref()
  app.addHook('preClose', async () => {
    clearInterval(sweep)
    app.server.off('upgrade', upgrade)
    for (const c of wss.clients) c.terminate()
    wss.close()
  })
  app.addHook('onClose', async () => {
    await repo.close()
  })
  if (staticRoot && existsSync(resolve(staticRoot, 'index.html'))) {
    await app.register(staticFiles, { root: staticRoot })
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api') || req.url.startsWith('/ws')
        ? reply.code(404).send({ code: 'NOT_FOUND', message: '接口不存在' })
        : reply.sendFile('index.html')
    )
  }
  await app.ready()
  return { app, rooms }
}
