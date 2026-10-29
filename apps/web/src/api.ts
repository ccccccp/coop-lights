import type { RoomSnapshot, SessionResponse } from '@lights/contracts'

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message)
  }
}
let gameToken: string | null = null
let gameTokenState: string | null = null
const loginNonces = new Map<string, string>()

/** 游戏会话只保存在当前页面内存；页面刷新后重新走用户授权。 */
export function setGameToken(token: string | null, state: string | null = null) {
  gameToken = token
  gameTokenState = token ? state : null
}
export async function request<T>(url: string, body?: unknown, sessionToken = gameToken): Promise<T> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: {
      ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined
      ? {
          method: 'POST',
          body: JSON.stringify(body),
        }
      : {}),
  })
  const data = await response.json()
  if (!response.ok) throw new ApiError(data.code ?? 'REQUEST_FAILED', data.message ?? '请求失败')
  return data as T
}
async function logoutSession(token: string | null) {
  const response = await request('/api/logout', {}, token)
  if (gameToken === token) setGameToken(null)
  return response
}
export const api = {
  session: () => request<SessionResponse>('/api/session'),
  login: (nickname: string) => request<SessionResponse>('/api/dev/session', { nickname }),
  logout: () => logoutSession(gameToken),
  prepareLogout() {
    const currentToken = gameToken
    return () => logoutSession(currentToken)
  },
  async beginKookLogin() {
    const clientNonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
      byte.toString(16).padStart(2, '0')
    ).join('')
    const transaction = await request<{ state: string }>('/api/kook/login/start', { clientNonce })
    loginNonces.set(transaction.state, clientNonce)
    return transaction
  },
  completeKookLogin: (code: string, state: string, instanceId?: string) =>
    request<SessionResponse>('/api/kook/login/complete', {
      code,
      state,
      instanceId,
      clientNonce: loginNonces.get(state),
    }),
  async cancelKookLogin(state: string) {
    try {
      return await request('/api/kook/login/cancel', { state, clientNonce: loginNonces.get(state) })
    } finally {
      loginNonces.delete(state)
      if (gameTokenState === state) setGameToken(null)
    }
  },
  finishKookLogin(state: string) {
    loginNonces.delete(state)
  },
  async revokeGameToken(token?: string) {
    if (!token) return
    // 只注销迟到响应创建的会话，不携带或清除更新的浏览器 Cookie。
    await fetch('/api/logout', {
      method: 'POST',
      credentials: 'omit',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    })
  },
  create: () => request<{ room: RoomSnapshot }>('/api/rooms', {}),
  join: (id: string) => request<{ room: RoomSnapshot }>(`/api/rooms/${id}/join`, {}),
  leave: (id: string) => request(`/api/rooms/${id}/leave`, {}),
  ticket: () => request<{ ticket: string }>('/api/ws-tickets', {}),
  hint: (id: string) => request<{ cells: number[] }>(`/api/rooms/${id}/hint`),
  health: () =>
    request<{
      storage: string
      reconnectGraceMs: number
      devTools: boolean
      oauthConfigured: boolean
      platform: { mode: string }
    }>('/api/health'),
}
