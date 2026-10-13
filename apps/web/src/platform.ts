import type { PlatformAdapter, SessionResponse } from '@lights/contracts'
import { api } from './api'

export function standaloneAdapter(): PlatformAdapter {
  return {
    initialize: api.session,
    login: api.login,
    async invite(roomId) {
      const url = new URL(location.href)
      url.search = ''
      url.searchParams.set('room', roomId)
      await navigator.clipboard.writeText(url.href)
      return { status: 'submitted', url: url.href }
    },
    dispose() {},
  }
}
// 这是本游戏的适配器注入点，不是假定的 KOOK 官方全局变量。
// 后续在独立模块实现真实 SDK 适配，OAuth 必须由游戏服务端核验。
declare global {
  interface Window {
    __LIGHTS_PLATFORM_ADAPTER__?: PlatformAdapter
  }
}
export function createPlatformAdapter(mode: string): PlatformAdapter {
  if (mode === 'standalone') return standaloneAdapter()
  if (window.__LIGHTS_PLATFORM_ADAPTER__) return window.__LIGHTS_PLATFORM_ADAPTER__
  return {
    async initialize(): Promise<SessionResponse> {
      throw new Error('KOOK SDK 尚未接入，请先使用独立模式')
    },
    async invite() {
      throw new Error('当前平台未提供邀请能力')
    },
    dispose() {},
  }
}
