import { randomBytes } from 'node:crypto'

import { z } from 'zod'

import { type PlatformContext, roomIdSchema } from '@lights/contracts'

import type { Config } from './config'
import { GameError, check } from './errors'
import type { Identity } from './storage'

export interface VerifiedIdentity {
  identity: Identity
  expiresAt: number
  launch?: { instanceId: string; invitedRoomId: string | null }
}

export function isOAuthConfigured(config: Config['kook']): boolean {
  return Boolean(
    config.clientId &&
    config.clientSecret &&
    config.redirectUri &&
    config.tokenUrl &&
    config.userInfoUrl &&
    config.gameCode &&
    config.contextUrl &&
    config.userIdField
  )
}

function endpoint(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new GameError('PLATFORM_NOT_CONFIGURED', '请配置有效的 KOOK OAuth 接口地址', 503)
  }
  check(
    !url.username &&
      !url.password &&
      !url.hash &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))),
    'PLATFORM_NOT_CONFIGURED',
    'KOOK OAuth 接口须使用 HTTPS；本地模拟服务可使用 loopback HTTP',
    503
  )
  return url.href
}

type OAuthStage = 'token' | 'userinfo' | 'context'

// 仅公开上游的错误字段；脱敏后再截断，避免将请求凭证带回浏览器。
function publicErrorText(value: unknown, secrets: string[]): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return
  let text = value
  const variants = secrets.filter(Boolean).flatMap((secret) => [secret, encodeURIComponent(secret)])
  for (const secret of [...new Set(variants)].sort((a, b) => b.length - a.length))
    text = text.split(secret).join('[REDACTED]')
  return text
    .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [REDACTED]')
    .replace(
      /(["']?(?:client_secret|access_token|refresh_token|auth_code|authorization|code)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi,
      '$1[REDACTED]'
    )
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 512)
}

async function readResponse(url: string, init: RequestInit, stage: OAuthStage, secrets: string[]) {
  const address = new URL(endpoint(url))
  const details = { stage, endpoint: address.origin + address.pathname }
  const label = stage === 'token' ? 'KOOK 换码' : stage === 'userinfo' ? 'KOOK 用户信息请求' : 'KOOK 实例上下文请求'
  let response: Response
  try {
    response = await fetch(address, { ...init, redirect: 'error', signal: AbortSignal.timeout(8000) })
  } catch (error) {
    const failure = error as { name?: string; cause?: { code?: string }; code?: string }
    const code = failure?.cause?.code ?? failure?.code
    const networkCode = ['TimeoutError', 'AbortError'].includes(failure?.name ?? '')
      ? 'TIMEOUT'
      : typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code)
        ? code
        : 'NETWORK_ERROR'
    const reason =
      networkCode === 'TIMEOUT'
        ? '请求超时'
        : networkCode === 'ENOTFOUND' || networkCode === 'EAI_AGAIN'
          ? '域名解析失败'
          : networkCode === 'ECONNREFUSED'
            ? '连接被拒绝'
            : '网络或 TLS 连接失败'
    throw new GameError('PLATFORM_LOGIN_FAILED', `${label}失败：${reason}（${networkCode}）`, 502, {
      ...details,
      network_code: networkCode,
    })
  }
  const responseDetails = { ...details, http_status: response.status }
  const parsed: unknown = await response.json().catch(() => undefined)
  const body =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
  // OAuth 错误使用 error/error_description；KOOK 业务错误使用 code/message。
  const upstreamCode = typeof body?.code === 'number' ? body.code : publicErrorText(body?.code ?? body?.error, secrets)
  const upstreamMessage = publicErrorText(body?.error_description ?? body?.message, secrets)
  if (!response.ok || (body && 'code' in body && body.code !== 0) || typeof body?.error === 'string') {
    const reason = [
      `HTTP ${response.status}`,
      upstreamCode,
      upstreamMessage,
      parsed === undefined ? '上游响应不是有效 JSON' : undefined,
    ]
      .filter((value) => value !== undefined)
      .join('；')
    throw new GameError('PLATFORM_LOGIN_FAILED', `${label}失败：${reason}`, 502, {
      ...responseDetails,
      ...(upstreamCode !== undefined ? { upstream_code: upstreamCode } : {}),
      ...(upstreamMessage ? { upstream_message: upstreamMessage } : {}),
    })
  }
  if (!body)
    throw new GameError('PLATFORM_RESPONSE_INVALID', `${label}响应格式不正确：需要 JSON 对象`, 502, responseDetails)
  if ('code' in body) {
    if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data))
      throw new GameError('PLATFORM_RESPONSE_INVALID', `${label}响应缺少 data 对象`, 502, responseDetails)
    return { data: body.data as Record<string, unknown>, details: responseDetails }
  }
  return { data: body, details: responseDetails }
}

function publicAvatarUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null
  } catch {
    return null
  }
}

export async function exchangeKookCode(
  config: Config['kook'],
  code: string,
  instanceId?: string
): Promise<VerifiedIdentity> {
  check(isOAuthConfigured(config), 'PLATFORM_NOT_CONFIGURED', '游戏服务端尚未配置 KOOK OAuth', 503)
  const secrets = [config.clientSecret, code]
  const received = await readResponse(
    config.tokenUrl,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        code,
      }),
    },
    'token',
    secrets
  )
  const token = z
    .object({
      access_token: z.string().min(1).max(16384),
      token_type: z.string().refine((value) => value.toLowerCase() === 'bearer'),
      expires_in: z.coerce.number().int().positive().max(31536000),
    })
    .safeParse(received.data)
  if (!token.success)
    throw new GameError('PLATFORM_RESPONSE_INVALID', 'KOOK 换码响应字段不正确', 502, {
      ...received.details,
      invalid_fields: token.error.issues.map((issue) => issue.path.join('.')),
    })
  secrets.push(token.data.access_token)
  if (typeof received.data.refresh_token === 'string') secrets.push(received.data.refresh_token)
  const expiresAt = Date.now() + token.data.expires_in * 1000
  const profile = await readResponse(
    config.userInfoUrl,
    {
      headers: { Authorization: `Bearer ${token.data.access_token}`, Accept: 'application/json' },
    },
    'userinfo',
    secrets
  )
  const identity = z
    .object({
      openCode: z.string().trim().min(1).max(256),
      nickname: z.string().trim().min(1).max(100),
    })
    .safeParse({ openCode: profile.data[config.userIdField!], nickname: profile.data[config.userNameField] })
  if (!identity.success)
    throw new GameError('PLATFORM_RESPONSE_INVALID', 'KOOK 用户身份字段与配置不一致', 502, {
      ...profile.details,
      invalid_fields: identity.error.issues.map((issue) =>
        issue.path[0] === 'openCode' ? config.userIdField : config.userNameField
      ),
    })
  let launch: VerifiedIdentity['launch']
  if (instanceId !== undefined) {
    // instanceId只是查询选择器；身份和游玩资格由KOOK按同一OAuth token复核。
    check(/^[A-Za-z0-9_-]{1,256}$/.test(instanceId), 'PLATFORM_CONTEXT_INVALID', '小游戏实例参数无效', 400)
    const url = new URL(endpoint(config.contextUrl))
    url.searchParams.set('game_code', config.gameCode)
    url.searchParams.set('instance_id', instanceId)
    const context = await readResponse(
      url.href,
      {
        headers: { Authorization: `Bearer ${token.data.access_token}`, Accept: 'application/json' },
      },
      'context',
      secrets
    )
    // 消费平台当前扁平DTO；不从SDK、URL或浏览器提交的房间号补齐可信字段。
    const parsed = z
      .object({
        game_code: z.literal(config.gameCode),
        instance_id: z.literal(instanceId),
        context_type: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
        context_id: z.string().min(1).max(256),
        room_id: roomIdSchema.or(z.literal('')).nullish(),
      })
      .safeParse(context.data)
    check(parsed.success, 'PLATFORM_CONTEXT_INVALID', 'KOOK 返回的游戏、实例或邀请房间不匹配', 502)
    launch = { instanceId: parsed.data.instance_id, invitedRoomId: parsed.data.room_id || null }
  }
  return {
    ...(launch ? { launch } : {}),
    identity: {
      appId: config.clientId,
      ...identity.data,
      avatarUrl: publicAvatarUrl(profile.data.avatar ?? profile.data.avatarUrl ?? profile.data.avatar_url),
    },
    expiresAt,
  }
}

interface LoginTransaction {
  browser: string
  expiresAt: number
  consumed: boolean
  cancelled: boolean
  sessionHash?: string
}

export class LoginTransactions {
  private entries = new Map<string, LoginTransaction>()

  begin(browser: string): string {
    this.sweep()
    check(this.entries.size < 1000, 'TOO_MANY_REQUESTS', '登录请求过多，请稍后重试', 429)
    for (const entry of this.entries.values()) if (entry.browser === browser) entry.cancelled = true
    const state = randomBytes(32).toString('hex')
    this.entries.set(state, { browser, expiresAt: Date.now() + 300000, consumed: false, cancelled: false })
    return state
  }

  consume(state: string, browser: string): LoginTransaction {
    const entry = this.entries.get(state)
    check(
      entry && entry.browser === browser && !entry.consumed && !entry.cancelled && entry.expiresAt > Date.now(),
      'LOGIN_TRANSACTION_INVALID',
      '登录请求已过期或失效，请重新登录',
      401
    )
    entry.consumed = true
    return entry
  }

  assertActive(entry: LoginTransaction): void {
    check(!entry.cancelled && entry.expiresAt > Date.now(), 'LOGIN_TRANSACTION_INVALID', '登录请求已取消或过期', 401)
  }

  cancel(browser: string, state?: string): string[] {
    const sessions: string[] = []
    for (const [key, entry] of this.entries) {
      if (entry.browser !== browser || (state && state !== key)) continue
      entry.cancelled = true
      if (entry.sessionHash) sessions.push(entry.sessionHash)
    }
    return sessions
  }

  sweep(): void {
    for (const [state, entry] of this.entries) if (entry.expiresAt <= Date.now()) this.entries.delete(state)
  }
}

export function platformContext(
  mode: 'standalone' | 'kook',
  launch?: { instanceId: string | null; invitedRoomId?: string | null }
): PlatformContext {
  return {
    mode,
    instanceId: launch?.instanceId ?? null,
    capabilities: mode === 'standalone' ? ['local.invite'] : [],
    authorizedScopes: [],
    availableScopes: [],
    status: mode === 'standalone' ? 'ready' : 'unavailable',
    connectionState: mode === 'standalone' ? 'connected' : 'idle',
    epoch: 0,
    invitedRoomId: launch?.invitedRoomId ?? null,
    participantsRevision: null,
    message: '',
  }
}
