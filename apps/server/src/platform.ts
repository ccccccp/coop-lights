import { randomBytes } from 'node:crypto'

import { z } from 'zod'

import type { PlatformContext } from '@lights/contracts'

import type { Config } from './config'
import { GameError, check } from './errors'
import type { Identity } from './storage'

export interface VerifiedIdentity {
  identity: Identity
  expiresAt: number
}

export function isOAuthConfigured(config: Config['kook']): boolean {
  return Boolean(
    config.clientId &&
    config.clientSecret &&
    config.redirectUri &&
    config.tokenUrl &&
    config.userInfoUrl &&
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

async function readResponse(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  try {
    const response = await fetch(endpoint(url), { ...init, redirect: 'error', signal: AbortSignal.timeout(8000) })
    check(response.ok, 'PLATFORM_LOGIN_FAILED', 'KOOK 登录服务未完成请求，请重新登录', 502)
    const body = (await response.json()) as Record<string, unknown>
    check(
      body && typeof body === 'object' && !Array.isArray(body),
      'PLATFORM_RESPONSE_INVALID',
      'KOOK 登录响应格式不正确',
      502
    )
    if ('code' in body) {
      check(body.code === 0, 'PLATFORM_LOGIN_FAILED', 'KOOK 登录服务拒绝了请求，请重新登录', 502)
      check(
        body.data && typeof body.data === 'object' && !Array.isArray(body.data),
        'PLATFORM_RESPONSE_INVALID',
        'KOOK 登录响应缺少数据',
        502
      )
      return body.data as Record<string, unknown>
    }
    return body
  } catch (error) {
    if (error instanceof GameError) throw error
    throw new GameError('PLATFORM_LOGIN_FAILED', 'KOOK 登录服务暂不可用，请重新登录', 502)
  }
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

export async function exchangeKookCode(config: Config['kook'], code: string): Promise<VerifiedIdentity> {
  check(isOAuthConfigured(config), 'PLATFORM_NOT_CONFIGURED', '游戏服务端尚未配置 KOOK OAuth', 503)
  const received = await readResponse(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      code,
    }),
  })
  const token = z
    .object({
      access_token: z.string().min(1).max(16384),
      token_type: z.string().refine((value) => value.toLowerCase() === 'bearer'),
      expires_in: z.coerce.number().int().positive().max(31536000),
    })
    .safeParse(received)
  check(token.success, 'PLATFORM_RESPONSE_INVALID', 'KOOK 换码响应格式不正确', 502)
  const expiresAt = Date.now() + token.data.expires_in * 1000
  const profile = await readResponse(config.userInfoUrl, {
    headers: { Authorization: `Bearer ${token.data.access_token}`, Accept: 'application/json' },
  })
  const identity = z
    .object({
      openCode: z.string().trim().min(1).max(256),
      nickname: z.string().trim().min(1).max(100),
    })
    .safeParse({ openCode: profile[config.userIdField!], nickname: profile[config.userNameField] })
  check(identity.success, 'PLATFORM_RESPONSE_INVALID', 'KOOK 用户身份字段与配置不一致', 502)
  return {
    identity: {
      appId: config.clientId,
      ...identity.data,
      avatarUrl: publicAvatarUrl(profile.avatar ?? profile.avatarUrl ?? profile.avatar_url),
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

export function platformContext(mode: 'standalone' | 'kook'): PlatformContext {
  return {
    mode,
    instanceId: null,
    capabilities: mode === 'standalone' ? ['local.invite'] : [],
    authorizedScopes: [],
    availableScopes: [],
    status: mode === 'standalone' ? 'ready' : 'unavailable',
    connectionState: mode === 'standalone' ? 'connected' : 'idle',
    epoch: 0,
    invitedRoomId: null,
    participantsRevision: null,
    message: '',
  }
}
