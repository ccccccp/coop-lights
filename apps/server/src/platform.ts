import type { PlatformContext } from '@lights/contracts'
import type { Identity } from './storage'

// 平台 provider 必须验证身份及上下文；不能信任前端传入的 instanceId。
// 平台 provider 必须验证身份及上下文；不能信任前端传入的 instanceId。
export interface VerifiedGrant {
  identity: Identity
  instanceId: string
  contextRevision: number
}
export interface IdentityProvider {
  exchange(transactionId: string, code: string): Promise<VerifiedGrant>
  refreshContext(sessionId: string): Promise<VerifiedGrant>
}
export function platformContext(mode: 'standalone' | 'kook'): PlatformContext {
  return {
    mode,
    instanceId: null,
    contextRevision: null,
    capabilities: mode === 'standalone' ? ['local.invite'] : [],
    authorizedScopes: [],
    status: mode === 'standalone' ? 'ready' : 'unavailable',
  }
}
