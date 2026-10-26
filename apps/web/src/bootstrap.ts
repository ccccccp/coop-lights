import type { KookClientOptions } from '@kookapp/kook-minigame-sdk'

let binding: KookClientOptions | null = null
const listeners = new Set<(options: KookClientOptions) => void>()

declare global {
  interface Window {
    /** Game-owned launcher entry. KOOK supplies these values directly through its trusted launcher. */
    startCoopLights: (options: KookClientOptions) => void
  }
}

export function startCoopLights(options: KookClientOptions): void {
  if (binding) {
    if (
      binding.hostOrigin === options.hostOrigin &&
      binding.sessionId === options.sessionId &&
      binding.generation === options.generation
    )
      return
    throw new Error('启动绑定已设置；更换账号或实例时请重新加载游戏页面')
  }
  binding = Object.freeze({
    hostOrigin: options.hostOrigin,
    sessionId: options.sessionId,
    generation: options.generation,
    ...(options.connectionTimeoutMs === undefined ? {} : { connectionTimeoutMs: options.connectionTimeoutMs }),
  })
  for (const listener of listeners) listener(binding)
  listeners.clear()
}

export function waitForBootstrap(signal: AbortSignal): Promise<KookClientOptions> {
  if (signal.aborted) return Promise.reject(new Error('游戏初始化已取消'))
  if (binding) return Promise.resolve(binding)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('尚未收到 KOOK 启动参数，请从宿主重新打开游戏'))
    }, 10000)
    function cleanup() {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      listeners.delete(ready)
    }
    function abort() {
      cleanup()
      reject(new Error('游戏初始化已取消'))
    }
    function ready(options: KookClientOptions) {
      cleanup()
      resolve(options)
    }
    signal.addEventListener('abort', abort, { once: true })
    listeners.add(ready)
  })
}
