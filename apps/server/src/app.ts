import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
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

import { createCallLogStore, safeRequest } from './callLogs'
import type { Config } from './config'
import { GameError, check } from './errors'
import { LoginTransactions, exchangeKookCode, isOAuthConfigured, platformContext, readKookContext } from './platform'
import { Rooms } from './rooms'
import type { Repository, Session } from './storage'

function hash(token: string) {
  return createHash('sha256').update(token).digest('hex')
}
function publicUser(u: GameUser) {
  return {
    id: u.id,
    nickname: u.nickname,
    avatarUrl: u.avatarUrl ?? null,
    completedRounds: u.completedRounds,
    totalMoves: u.totalMoves,
  }
}
export async function createApp(config: Config, repo: Repository, staticRoot?: string) {
  const app = Fastify({
    genReqId: () => randomUUID(),
    bodyLimit: 8192,
    ...(config.tls ? { https: config.tls } : {}),
    logger: {
      level: 'warn',
      redact: ['req.headers.cookie', 'req.headers.authorization'],
    },
  })
  await app.register(cookie)
  const clients = new Map<string, { ws: WebSocket; id: string; session: Session; alive: boolean }>()
  const tickets = new Map<string, { session: Session; expiresAt: number }>()
  const transactions = new LoginTransactions()
  const callLogs = createCallLogStore(
    repo,
    () => app.log.warn('call log persistence unavailable'),
    config.logRetentionDays
  )
  const grants = new Map<string, { accessToken: string; expiresAt: number; verifiedRoom?: string | null }>()
  const httpStarts = new WeakMap<object, number>()
  const nonceSchema = z.string().regex(/^[a-f0-9]{64}$/)
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
  function requestToken(req: FastifyRequest) {
    if (config.mode === 'kook' && req.headers.authorization !== undefined) {
      const match = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization)
      check(match, 'UNAUTHENTICATED', '游戏登录凭证无效，请重新登录', 401)
      return match[1]
    }
    return req.cookies.lights_session
  }
  function loginBinding(req: FastifyRequest, clientNonce?: string) {
    // 两种绑定使用不同命名空间；错误或缺失的 nonce 不能降级为 Cookie 身份。
    return hash(
      clientNonce ? `nonce:${req.headers.origin ?? ''}:${clientNonce}` : `cookie:${req.cookies.lights_oauth ?? ''}`
    )
  }
  const rooms = new Rooms(repo, config.maxPlayers, config.graceMs, (id, event) => {
    for (const [uid, c] of clients) if (rooms.forUser(uid)?.id === id) send(c.ws, event)
  })
  async function auth(req: FastifyRequest) {
    const token = requestToken(req)
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
    httpStarts.set(req, Date.now())
    const origin = req.headers.origin
    if (req.method !== 'GET' && req.method !== 'HEAD')
      check(origin && config.allowedOrigins.includes(origin), 'ORIGIN_DENIED', '请求来源不允许', 403)
  })
  app.addHook('onSend', async (req, reply) => {
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store')
  })
  app.addHook('onSend', async (req, reply, payload) => {
    if (!req.url.startsWith('/api/') || req.url.startsWith('/api/logs') || req.url === '/api/health') return
    const startedAt = httpStarts.get(req) ?? Date.now()
    let body: unknown = payload
    if (typeof payload === 'string') {
      try {
        body = JSON.parse(payload)
      } catch {
        /* 保留文本响应。 */
      }
    }
    const request = safeRequest(req.url, req.body)
    const businessCode = body && typeof body === 'object' ? (body as { code?: string | number }).code : null
    await callLogs.record(
      {
        requestId: req.id,
        kind: 'game',
        method: req.method,
        endpoint: request.endpoint,
        startedAt,
        durationMs: Date.now() - startedAt,
        status: reply.statusCode,
        ok: reply.statusCode < 400,
        businessCode,
        request: request.request,
        response: body,
      },
      [config.kook.clientSecret, config.logAccessKey]
    )
  })
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof GameError)
      return reply.code(error.statusCode).send({ code: error.code, message: error.message, details: error.details })
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
    grants.delete(sessionHash)
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
    const input = z
      .object({ clientNonce: nonceSchema.optional() })
      .strict()
      .parse(req.body ?? {})
    const existing = req.cookies.lights_oauth
    const browser = existing && /^[a-f0-9]{64}$/.test(existing) ? existing : randomBytes(32).toString('hex')
    const state = transactions.begin(
      input.clientNonce ? loginBinding(req, input.clientNonce) : hash(`cookie:${browser}`)
    )
    reply.header('Cache-Control', 'no-store').setCookie('lights_oauth', browser, { ...cookieOptions, maxAge: 300 })
    return { state }
  })
  app.post('/api/kook/login/complete', async (req, reply) => {
    requireKook()
    const oldToken = requestToken(req)
    const input = z
      .object({
        state: nonceSchema,
        code: z.string().min(1).max(4096).regex(/^\S+$/),
        instanceId: z
          .string()
          .regex(/^[A-Za-z0-9_-]{1,256}$/)
          .optional(),
        clientNonce: nonceSchema.optional(),
      })
      .strict()
      .parse(req.body)
    const transaction = transactions.consume(input.state, loginBinding(req, input.clientNonce))
    const grant = await exchangeKookCode(config.kook, input.code, callLogs.recorder(req.id))
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
    // 基本登录不依赖平台实例查询；OAuth凭据仅在当前游戏后端内存中驻留。
    await repo.saveSession(session)
    transaction.sessionHash = session.hash
    grants.set(session.hash, { accessToken: grant.accessToken, expiresAt: session.expiresAt })
    if (transaction.cancelled || transaction.expiresAt <= Date.now()) {
      grants.delete(session.hash)
      await repo.deleteSession(session.hash)
      transactions.assertActive(transaction)
    }
    const old = oldToken ? await repo.getSession(hash(oldToken)) : null
    if (old) {
      if (old.userId !== user.id) await revokeSession(old.hash)
      else {
        grants.delete(old.hash)
        await repo.deleteSession(old.hash)
        const active = clients.get(user.id)
        if (active?.session.hash === old.hash) active.ws.close(4001, 'session renewed')
      }
    }
    transactions.assertActive(transaction)
    await rooms.updateProfile(user)
    transactions.assertActive(transaction)
    reply.header('Cache-Control', 'no-store').setCookie('lights_session', token, {
      ...cookieOptions,
      maxAge: Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000)),
    })
    // 这是游戏自己的短期会话，不是 KOOK OAuth token；用于浏览器阻止第三方 Cookie 的情况。
    return {
      user: publicUser(user),
      room: rooms.forUser(user.id),
      platform: platformContext(config.mode),
      ...(input.clientNonce ? { gameToken: token } : {}),
    }
  })
  app.post('/api/kook/invite/resolve', async (req) => {
    const { session } = await auth(req)
    const { instanceId } = z
      .object({ instanceId: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/) })
      .strict()
      .parse(req.body)
    const grant = grants.get(session.hash)
    check(grant && grant.expiresAt > Date.now(), 'PLATFORM_GRANT_UNAVAILABLE', '请重新授权后再接受邀请', 401)
    grant.verifiedRoom = undefined
    const launch = await readKookContext(config.kook, grant.accessToken, instanceId, callLogs.recorder(req.id))
    // 查询返回时再次确认游戏会话仍有效，旧结果不能复活已注销的登录。
    check(await repo.getSession(session.hash), 'UNAUTHENTICATED', '游戏登录已失效', 401)
    grant.verifiedRoom = launch.invitedRoomId
    return launch
  })
  app.get('/api/logs', async (req) => {
    check(config.logAccessKey, 'LOGS_NOT_CONFIGURED', '请在服务端配置 LOG_ACCESS_KEY 后查询日志', 503)
    const supplied = typeof req.headers['x-log-key'] === 'string' ? req.headers['x-log-key'] : ''
    check(
      timingSafeEqual(Buffer.from(hash(supplied), 'hex'), Buffer.from(hash(config.logAccessKey), 'hex')),
      'LOG_ACCESS_DENIED',
      '日志访问密钥不正确',
      401
    )
    check(repo.listCallLogs, 'LOGS_UNAVAILABLE', '日志查询暂不可用', 503)
    const query = z
      .object({
        from: z.string().optional(),
        to: z.string().optional(),
        kind: z.enum(['game', 'kook']).optional(),
        errors: z.enum(['true', 'false']).optional(),
        search: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        cursorTime: z.coerce.number().int().nonnegative().optional(),
        cursorId: z.string().uuid().optional(),
      })
      .strict()
      .parse(req.query)
    const to = query.to ? Date.parse(query.to) : Date.now(),
      from = query.from ? Date.parse(query.from) : to - 3 * 86400000
    check(Number.isFinite(from) && Number.isFinite(to) && from <= to, 'INVALID_INPUT', '日志时间范围不正确')
    check((query.cursorTime === undefined) === (query.cursorId === undefined), 'INVALID_INPUT', '日志分页参数不完整')
    await callLogs.flush()
    const items = await repo.listCallLogs({
      from,
      to,
      kind: query.kind,
      errorsOnly: query.errors === 'true',
      search: query.search,
      limit: query.limit + 1,
      ...(query.cursorTime !== undefined ? { cursor: { startedAt: query.cursorTime, id: query.cursorId! } } : {}),
    })
    const more = items.length > query.limit,
      page = items.slice(0, query.limit),
      last = page[page.length - 1]
    return { items: page, from, to, nextCursor: more && last ? { startedAt: last.startedAt, id: last.id } : null }
  })
  app.post('/api/kook/login/cancel', async (req) => {
    const { state, clientNonce } = z
      .object({ state: nonceSchema, clientNonce: nonceSchema.optional() })
      .strict()
      .parse(req.body)
    for (const session of transactions.cancel(loginBinding(req, clientNonce), state)) await revokeSession(session)
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
    const { user, session } = await auth(req)
    return {
      user: publicUser(user),
      room: rooms.forUser(user.id),
      platform: platformContext(config.mode, { instanceId: session.instanceId }),
    }
  })
  app.post('/api/logout', async (req, reply) => {
    const token = requestToken(req)
    if (token) await revokeSession(hash(token))
    for (const session of transactions.cancel(loginBinding(req))) await revokeSession(session)
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
      room = await rooms.join(
        id,
        user,
        grants.get(session.hash)?.verifiedRoom === id
          ? (rooms.snapshot(id)?.platformInstanceId ?? null)
          : session.instanceId
      ),
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
    for (const [key, grant] of grants) if (grant.expiresAt <= now) grants.delete(key)
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
    grants.clear()
    await callLogs.flush()
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
