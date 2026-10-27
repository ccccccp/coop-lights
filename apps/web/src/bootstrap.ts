import type { KookClientOptions } from '@kookapp/kook-minigame-sdk'

let binding: KookClientOptions | null = null

export function waitForBootstrap(signal: AbortSignal): Promise<KookClientOptions> {
  if (signal.aborted) return Promise.reject(new Error('游戏初始化已取消'))
  if (binding) return Promise.resolve(binding)
  const origins: string[] = (import.meta.env.VITE_KOOK_HOST_ORIGINS ?? '')
    .split(',')
    .map((value: string) => value.trim())
    .filter(Boolean)
  if (
    !origins.length ||
    origins.some((value: string) => {
      try {
        const url = new URL(value)
        return url.protocol !== 'https:' || url.origin !== value
      } catch {
        return true
      }
    })
  )
    return Promise.reject(new Error('请配置 VITE_KOOK_HOST_ORIGINS 为可信 KOOK 宿主的 HTTPS origin'))
  const allowedOrigins = new Set(origins)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('尚未收到 KOOK 启动参数，请从宿主重新打开游戏'))
    }, 10000)
    function cleanup() {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      window.removeEventListener('message', receive)
    }
    function abort() {
      cleanup()
      reject(new Error('游戏初始化已取消'))
    }
    function receive(event: MessageEvent) {
      if (window.parent === window || event.source !== window.parent || !allowedOrigins.has(event.origin)) return
      if (event.data?.type !== 'KOOK_MINI_GAME_BOOTSTRAP') return
      const options = event.data.bootstrap
      if (
        !options ||
        options.hostOrigin !== event.origin ||
        typeof options.sessionId !== 'string' ||
        !options.sessionId.length ||
        options.sessionId.length > 256 ||
        // oxlint-disable-next-line no-control-regex -- Reject control characters in the bridge binding.
        /[\s\u0000-\u001f\u007f]/u.test(options.sessionId) ||
        !Number.isSafeInteger(options.generation) ||
        options.generation < 0
      )
        return
      // 每页只绑定一次；重新打开游戏由宿主创建新的 iframe。
      binding = Object.freeze({
        hostOrigin: event.origin,
        sessionId: options.sessionId,
        generation: options.generation,
      })
      cleanup()
      resolve(binding)
    }
    signal.addEventListener('abort', abort, { once: true })
    window.addEventListener('message', receive)
    // health 请求可能晚于 iframe 的 load 投递，注册监听后主动申请重投。
    for (const origin of allowedOrigins) window.parent.postMessage({ type: 'KOOK_MINI_GAME_BOOTSTRAP_REQUEST' }, origin)
  })
}
