export type ProbeKind = 'image' | 'script' | 'fetch' | 'websocket'
export interface ProbeOptions {
  method: 'GET' | 'HEAD' | 'POST'
  body: string
  moduleScript: boolean
  timeoutMs: number
}
export interface ProbeResult {
  outcome: 'success' | 'response' | 'failed' | 'timeout' | 'cancelled' | 'invalid'
  detail: string
  status?: number
  finalUrl?: string
}

function parseUrl(kind: ProbeKind, value: string): URL {
  if (!/^([a-z][a-z0-9+.-]*:|\/)/i.test(value.trim()))
    throw new Error('请包含协议（如 https://），或使用 / 开头的相对地址')
  const url = new URL(value.trim(), location.href)
  if (!value.trim() || url.username || url.password) throw new Error('请输入不含账号密码的完整地址或相对地址')
  const protocols = kind === 'websocket' ? ['ws:', 'wss:'] : ['http:', 'https:']
  if (!protocols.includes(url.protocol))
    throw new Error(
      kind === 'websocket' ? 'WebSocket 地址需使用 ws:// 或 wss://' : '资源地址需使用 http:// 或 https://'
    )
  return url
}

/** 使用浏览器原生请求，不经过游戏后端代理，也不使用带游戏令牌的 API 封装。 */
export function runProbe(
  kind: ProbeKind,
  value: string,
  options: ProbeOptions,
  signal: AbortSignal
): Promise<ProbeResult> {
  let url: URL
  try {
    url = parseUrl(kind, value)
  } catch (error) {
    return Promise.resolve({ outcome: 'invalid', detail: error instanceof Error ? error.message : '地址无效' })
  }
  if (signal.aborted) return Promise.resolve({ outcome: 'cancelled', detail: '测试已取消' })
  return new Promise((resolve) => {
    const controller = new AbortController()
    let finished = false
    let cleanup = () => {}
    const timer = setTimeout(
      () => finish({ outcome: 'timeout', detail: '等待超时；不能仅据此判定已被拦截' }),
      options.timeoutMs
    )
    const abort = () => finish({ outcome: 'cancelled', detail: '测试已取消' })
    function finish(result: ProbeResult): void {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      controller.abort()
      cleanup()
      resolve(result)
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) return abort()

    if (kind === 'image') {
      const image = new Image()
      image.referrerPolicy = 'no-referrer'
      cleanup = () => {
        image.onload = null
        image.onerror = null
        image.removeAttribute('src')
      }
      image.onload = () =>
        finish({ outcome: 'success', detail: `图片已加载，尺寸 ${image.naturalWidth} × ${image.naturalHeight}` })
      image.onerror = () =>
        finish({ outcome: 'failed', detail: '图片加载失败；可能被拦截，也可能是网络或图片格式错误' })
      image.src = url.href
      return
    }
    if (kind === 'script') {
      // 隔离输入脚本，避免测试代码读取游戏页面、会话或修改游戏界面。
      const frame = document.createElement('iframe')
      frame.hidden = true
      frame.setAttribute('sandbox', 'allow-scripts')
      frame.setAttribute('referrerpolicy', 'no-referrer')
      const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
        byte.toString(16).padStart(2, '0')
      ).join('')
      const encode = (input: string) => JSON.stringify(input).replace(/</g, '\u003c')
      const receive = (event: MessageEvent) => {
        if (
          event.source !== frame.contentWindow ||
          event.data?.type !== 'lights-network-script' ||
          event.data.id !== id
        )
          return
        if (event.data.result === 'loaded')
          finish({ outcome: 'success', detail: 'JS 文件已加载；不代表脚本运行没有错误' })
        else if (event.data.result === 'failed')
          finish({ outcome: 'failed', detail: 'JS 加载失败；模块脚本还需满足跨域 CORS 要求' })
      }
      cleanup = () => {
        window.removeEventListener('message', receive)
        frame.remove()
      }
      window.addEventListener('message', receive)
      frame.srcdoc = `<!doctype html><meta charset="utf-8"><body><script>
        const script = document.createElement('script');
        script.src = ${encode(url.href)};
        ${options.moduleScript ? "script.type = 'module';" : ''}
        const report = result => parent.postMessage({ type: 'lights-network-script', id: ${encode(id)}, result }, ${encode(location.origin)});
        script.onload = () => report('loaded');
        script.onerror = () => report('failed');
        document.body.append(script);
      </script></body>`
      document.body.append(frame)
      return
    }
    if (kind === 'websocket') {
      let socket: WebSocket
      try {
        socket = new WebSocket(url.href)
      } catch {
        finish({ outcome: 'failed', detail: 'WebSocket 无法创建；请检查地址、协议和页面策略' })
        return
      }
      cleanup = () => {
        socket.onopen = null
        socket.onerror = null
        socket.onclose = null
        socket.close()
      }
      socket.onopen = () => finish({ outcome: 'success', detail: 'WebSocket 握手成功，已主动关闭；未发送业务消息' })
      socket.onerror = () =>
        finish({ outcome: 'failed', detail: 'WebSocket 连接失败；可能被拦截、鉴权失败或服务不可用' })
      socket.onclose = (event) =>
        finish({ outcome: 'failed', detail: `WebSocket 未完成握手即关闭，code=${event.code}` })
      return
    }

    void fetch(url.href, {
      method: options.method,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
      ...(options.method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: options.body } : {}),
    }).then(
      (response) => {
        // 收到 4xx/5xx 也说明请求到达并取得响应，不把业务错误误报成网络拦截。
        const contentType = response.headers.get('content-type') ?? '未声明类型'
        void response.body?.cancel().catch(() => {})
        finish({
          outcome: 'response',
          status: response.status,
          finalUrl: response.url,
          detail: `已收到 HTTP ${response.status} ${response.statusText}；${contentType}`,
        })
      },
      () => finish({ outcome: 'failed', detail: '请求失败，未取得可读响应；可能是域名拦截、CORS、证书或网络问题' })
    )
  })
}
