import type { RoomSnapshot, SessionResponse } from '@lights/contracts'

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message)
  }
}
export async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...(body !== undefined
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  })
  const data = await response.json()
  if (!response.ok) throw new ApiError(data.code ?? 'REQUEST_FAILED', data.message ?? '请求失败')
  return data as T
}
export const api = {
  session: () => request<SessionResponse>('/api/session'),
  login: (nickname: string) => request<SessionResponse>('/api/dev/session', { nickname }),
  logout: () => request('/api/logout', {}),
  beginKookLogin: () => request<{ state: string }>('/api/kook/login/start', {}),
  completeKookLogin: (code: string, state: string) =>
    request<SessionResponse>('/api/kook/login/complete', { code, state }),
  cancelKookLogin: (state: string) => request('/api/kook/login/cancel', { state }),
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
