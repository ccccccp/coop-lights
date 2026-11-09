import { useEffect, useRef, useState } from 'react'

import type { PlatformAdapter, PlatformContext } from '@lights/contracts'

import { type ProbeKind, type ProbeResult, runProbe } from './probes'

import { ExternalLinkTest } from '../ExternalLinkTest'
import { api } from '../api'
import { createPlatformAdapter } from '../platform'

import './index.css'

const kinds: { kind: ProbeKind; title: string; placeholder: string; note: string }[] = [
  {
    kind: 'image',
    title: '图片地址',
    placeholder: 'https://cdn.example.com/test.png',
    note: '使用原生图片加载，成功时显示图片尺寸。',
  },
  {
    kind: 'script',
    title: 'JS 文件地址',
    placeholder: 'https://cdn.example.com/test.js',
    note: '在隔离 iframe 中加载和执行，测试脚本无法直接访问游戏页面。',
  },
  {
    kind: 'fetch',
    title: '接口请求地址',
    placeholder: 'https://api.example.com/health',
    note: '直接从当前游戏页面请求，不携带游戏令牌或 Cookie，不经后端代理。',
  },
  {
    kind: 'websocket',
    title: 'WebSocket 地址',
    placeholder: 'wss://ws.example.com/socket',
    note: '只测试连接握手，成功后关闭，不发送业务消息。',
  },
]
const labels: Record<ProbeResult['outcome'], string> = {
  success: '加载 / 连接成功',
  response: '已收到响应',
  failed: '失败（可能被拦截）',
  timeout: '超时',
  cancelled: '已取消',
  invalid: '地址无效',
}
interface RecordEntry {
  id: number
  kind: ProbeKind
  url: string
  time: string
  duration: number
  result: ProbeResult
}

interface Props {
  onClose?: () => void
  adapter?: PlatformAdapter | null
  platform?: PlatformContext | null
}

export function NetworkTestPage({ onClose, adapter: suppliedAdapter, platform: suppliedPlatform }: Props) {
  const embedded = Boolean(onClose)
  const ownAdapter = useRef<PlatformAdapter | null>(null)
  const [ownPlatform, setOwnPlatform] = useState<PlatformContext | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const controllers = useRef(new Map<ProbeKind, AbortController>())
  const serial = useRef(0)
  const [urls, setUrls] = useState<Record<ProbeKind, string>>({
    image: '',
    script: '',
    fetch: new URL('/api/health', location.href).href,
    websocket: '',
  })
  const [method, setMethod] = useState<'GET' | 'HEAD' | 'POST'>('GET')
  const [body, setBody] = useState('{}')
  const [moduleScript, setModuleScript] = useState(false)
  const [timeoutMs, setTimeoutMs] = useState(5000)
  const [running, setRunning] = useState<ProbeKind[]>([])
  const [entries, setEntries] = useState<RecordEntry[]>([])
  const [connection, setConnection] = useState(embedded ? '沿用当前游戏连接' : '正在检查运行环境…')

  useEffect(() => {
    if (!embedded) return
    const element = dialog.current!
    element.showModal()
    return () => element.close()
  }, [embedded])
  useEffect(
    () => () => {
      for (const controller of controllers.current.values()) controller.abort()
      controllers.current.clear()
    },
    []
  )
  useEffect(() => {
    if (embedded) return
    let alive = true
    let adapter: PlatformAdapter | undefined
    let unsubscribe: (() => void) | undefined
    void (async () => {
      const health = await api.health()
      if (!alive) return
      adapter = createPlatformAdapter(health.platform.mode)
      ownAdapter.current = adapter
      unsubscribe = adapter.subscribe((event) => {
        if (alive && event.type === 'context') {
          setConnection(event.platform.mode === 'kook' ? `KOOK · ${event.platform.status}` : '独立模式 / 浏览器')
          setOwnPlatform(event.platform)
        }
      })
      await adapter.initialize()
      if (alive) await adapter.reportLoaded()
    })().catch((error) => {
      if (alive) setConnection(`连接未就绪：${error instanceof Error ? error.message : '初始化失败'}`)
    })
    return () => {
      alive = false
      unsubscribe?.()
      adapter?.dispose()
      if (ownAdapter.current === adapter) ownAdapter.current = null
    }
  }, [embedded])

  async function test(kind: ProbeKind) {
    if (controllers.current.has(kind)) return
    const controller = new AbortController()
    controllers.current.set(kind, controller)
    setRunning([...controllers.current.keys()])
    const url = urls[kind].trim(),
      started = performance.now(),
      id = ++serial.current
    try {
      const result = await runProbe(kind, url, { method, body, moduleScript, timeoutMs }, controller.signal)
      if (controllers.current.get(kind) !== controller) return
      setEntries((previous) =>
        [
          {
            id,
            kind,
            url,
            time: new Date().toLocaleTimeString(),
            duration: Math.round(performance.now() - started),
            result,
          },
          ...previous,
        ].slice(0, 50)
      )
    } finally {
      if (controllers.current.get(kind) === controller) {
        controllers.current.delete(kind)
        setRunning([...controllers.current.keys()])
      }
    }
  }
  const content = (
    <main className="network-test-page">
      <header>
        <div>
          <p className="eyebrow">CO-OP LIGHTS · NETWORK</p>
          <h1>网络拦截测试</h1>
          <p>在游戏当前承载中测试资源和请求。PC 由 KOOK 允许域名规则控制，Web 显示浏览器原生结果。</p>
        </div>
        {onClose ? (
          <button className="secondary" onClick={onClose}>
            返回游戏
          </button>
        ) : (
          <a href="/">返回游戏 →</a>
        )}
      </header>
      <div className="network-test-context">
        <span>{connection}</span>
        <span>当前来源：{location.origin}</span>
      </div>
      <p className="network-test-help">
        失败不一定代表被拦截，也可能由 CORS、证书、网络或资源格式引起。可结合 PC 开发者工具中的{' '}
        <code>ERR_BLOCKED_BY_CLIENT</code> 确认。HTTP 4xx / 5xx 仍记为“已收到响应”。
      </p>
      <div className="network-test-toolbar">
        <label>
          等待超时
          <select
            aria-label="等待超时"
            value={timeoutMs}
            onChange={(event) => setTimeoutMs(Number(event.target.value))}
          >
            <option value={3000}>3 秒</option>
            <option value={5000}>5 秒</option>
            <option value={10000}>10 秒</option>
            <option value={30000}>30 秒</option>
          </select>
        </label>
        <button
          className="secondary"
          disabled={running.length > 0 || !Object.values(urls).some((value) => value.trim())}
          onClick={() => {
            for (const { kind } of kinds) if (urls[kind].trim()) void test(kind)
          }}
        >
          测试已填写地址
        </button>
        <button
          className="secondary"
          disabled={!running.length}
          onClick={() => {
            for (const controller of controllers.current.values()) controller.abort()
          }}
        >
          取消进行中的测试
        </button>
      </div>
      <div className="network-test-grid">
        {kinds.map(({ kind, title, placeholder, note }) => (
          <form
            key={kind}
            className="network-test-card"
            onSubmit={(event) => {
              event.preventDefault()
              void test(kind)
            }}
          >
            <h2>{title}</h2>
            <p>{note}</p>
            <label htmlFor={`probe-${kind}`}>测试地址</label>
            <input
              id={`probe-${kind}`}
              aria-label={title}
              value={urls[kind]}
              placeholder={placeholder}
              onChange={(event) => setUrls({ ...urls, [kind]: event.target.value })}
              autoComplete="off"
              spellCheck={false}
            />
            {kind === 'script' && (
              <label className="network-test-checkbox">
                <input
                  type="checkbox"
                  checked={moduleScript}
                  onChange={(event) => setModuleScript(event.target.checked)}
                />
                按 ES Module 加载（跨域需要 CORS）
              </label>
            )}
            {kind === 'fetch' && (
              <>
                <label>
                  请求方法
                  <select
                    aria-label="请求方法"
                    value={method}
                    onChange={(event) => setMethod(event.target.value as typeof method)}
                  >
                    <option>GET</option>
                    <option>HEAD</option>
                    <option>POST</option>
                  </select>
                </label>
                {method === 'POST' && (
                  <label>
                    请求体
                    <textarea
                      aria-label="请求体"
                      value={body}
                      onChange={(event) => setBody(event.target.value)}
                      spellCheck={false}
                    />
                  </label>
                )}
              </>
            )}
            <button className="primary" type="submit" disabled={running.includes(kind) || !urls[kind].trim()}>
              {running.includes(kind) ? '测试中…' : `测试${title.replace('地址', '')}`}
            </button>
          </form>
        ))}
      </div>
      <ExternalLinkTest
        adapter={embedded ? suppliedAdapter : ownAdapter.current}
        platform={embedded ? suppliedPlatform : ownPlatform}
      />
      <section className="network-test-results" aria-label="测试结果">
        <div className="network-test-results-title">
          <h2>测试结果</h2>
          <button
            className="text-button"
            disabled={!entries.length || running.length > 0}
            onClick={() => setEntries([])}
          >
            清空记录
          </button>
        </div>
        <p>最近 50 条，仅保存在当前页面。JS 成功表示文件已加载，不保证业务代码执行无误。</p>
        {!entries.length ? (
          <p>填写地址后点击测试。</p>
        ) : (
          <ol>
            {entries.map((entry) => (
              <li
                key={entry.id}
                className={`network-test-result result-${entry.result.outcome}`}
                data-testid={`probe-result-${entry.kind}`}
              >
                <div className="network-test-result-top">
                  <strong>{labels[entry.result.outcome]}</strong>
                  <span>
                    {kinds.find((item) => item.kind === entry.kind)!.title} · {entry.duration} ms · {entry.time}
                  </span>
                </div>
                <code>{entry.url}</code>
                <p>{entry.result.detail}</p>
                {entry.result.finalUrl && <p>最终地址：{entry.result.finalUrl}</p>}
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  )
  return embedded ? (
    <dialog
      ref={dialog}
      className="network-test-dialog"
      aria-label="网络拦截测试"
      onCancel={(event) => {
        event.preventDefault()
        onClose?.()
      }}
    >
      {content}
    </dialog>
  ) : (
    content
  )
}
