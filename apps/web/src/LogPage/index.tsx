import { useState } from 'react'

import './index.css'

interface LogEntry {
  id: string
  requestId: string
  kind: 'game' | 'kook'
  stage?: string
  method: string
  endpoint: string
  startedAt: number
  durationMs: number
  status: number | null
  ok: boolean
  businessCode?: string | number | null
  request: unknown
  response: unknown
  error?: unknown
}
type Cursor = { startedAt: number; id: string }
function localTime(value: number) {
  return new Date(value - new Date(value).getTimezoneOffset() * 60000).toISOString().slice(0, 19)
}
export function LogPage({ onClose }: { onClose?: () => void }) {
  const [key, setKey] = useState(''),
    [from, setFrom] = useState(() => localTime(Date.now() - 3 * 86400000)),
    [to, setTo] = useState('')
  const [kind, setKind] = useState(''),
    [search, setSearch] = useState(''),
    [errorsOnly, setErrorsOnly] = useState(false)
  const [entries, setEntries] = useState<LogEntry[]>([]),
    [cursor, setCursor] = useState<Cursor | null>(null)
  const [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [range, setRange] = useState<{ from: number; to: number } | null>(null)
  async function query(next?: Cursor) {
    if (loading) return
    setLoading(true)
    setError('')
    try {
      const start = next && range ? range.from : new Date(from).getTime(),
        end = next && range ? range.to : to ? new Date(to).getTime() : Date.now()
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) throw new Error('请选择正确的时间范围')
      const parameters = new URLSearchParams({
        limit: '50',
        from: new Date(start).toISOString(),
        to: new Date(end).toISOString(),
      })
      if (kind) parameters.set('kind', kind)
      if (search.trim()) parameters.set('search', search.trim())
      if (errorsOnly) parameters.set('errors', 'true')
      if (next) {
        parameters.set('cursorTime', String(next.startedAt))
        parameters.set('cursorId', next.id)
      }
      const response = await fetch('/api/logs?' + parameters, { credentials: 'omit', headers: { 'x-log-key': key } }),
        data = await response.json()
      if (!response.ok) throw new Error(data.message || '日志查询失败')
      setEntries((previous) => (next ? [...previous, ...data.items] : data.items))
      setCursor(data.nextCursor)
      setRange({ from: data.from, to: data.to })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '日志查询失败')
    } finally {
      setLoading(false)
    }
  }
  return (
    <main className="call-log-page">
      <header>
        <div>
          <p className="eyebrow">CO-OP LIGHTS</p>
          <h1>接口调用日志</h1>
          <p>默认最近 3 天，最新调用在前。包含游戏 API 和 KOOK 请求；敏感凭据已脱敏。</p>
        </div>
        {onClose ? (
          <button className="secondary" onClick={onClose}>
            返回游戏
          </button>
        ) : (
          <a href="/">返回游戏 →</a>
        )}
      </header>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void query()
        }}
      >
        <label>
          日志访问密钥
          <input
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => {
              setKey(e.target.value)
              setEntries([])
              setCursor(null)
              setRange(null)
            }}
            placeholder="服务端 LOG_ACCESS_KEY"
            required
          />
        </label>
        <label>
          开始时间
          <input
            type="datetime-local"
            step="1"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value)
              setCursor(null)
            }}
            required
          />
        </label>
        <label>
          结束时间（留空为当前）
          <input
            type="datetime-local"
            step="1"
            value={to}
            onChange={(e) => {
              setTo(e.target.value)
              setCursor(null)
            }}
          />
        </label>
        <label>
          接口来源
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value)
              setCursor(null)
            }}
          >
            <option value="">全部接口</option>
            <option value="kook">KOOK 接口</option>
            <option value="game">游戏接口</option>
          </select>
        </label>
        <label>
          接口或请求编号
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setCursor(null)
            }}
            placeholder="例如 mini-game/context"
          />
        </label>
        <label className="log-checkbox">
          <input
            type="checkbox"
            checked={errorsOnly}
            onChange={(e) => {
              setErrorsOnly(e.target.checked)
              setCursor(null)
            }}
          />
          只看失败
        </label>
        <button className="primary" type="submit" disabled={loading}>
          {loading ? '查询中…' : '查询 / 刷新'}
        </button>
      </form>
      {error && (
        <p className="log-error" role="alert">
          {error}
        </p>
      )}
      {range && (
        <p>
          {new Date(range.from).toLocaleString()} — {new Date(range.to).toLocaleString()} · 已加载 {entries.length} 条 ·
          时间倒序
        </p>
      )}
      <div className="log-table-wrap">
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>接口</th>
              <th>状态</th>
              <th>耗时</th>
              <th>调用详情</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td>
                  <time dateTime={new Date(entry.startedAt).toISOString()}>
                    {new Date(entry.startedAt).toLocaleString()}
                  </time>
                </td>
                <td>
                  <span className="log-source">
                    {entry.kind === 'kook' ? 'KOOK' : '游戏'}
                    {entry.stage ? ' · ' + entry.stage : ''}
                  </span>
                  <br />
                  <b>{entry.method}</b> {entry.endpoint}
                </td>
                <td>
                  <span className={entry.ok ? 'log-ok' : 'log-error'}>{entry.status ?? '网络错误'}</span>
                  <br />
                  业务码：{entry.businessCode ?? '—'}
                </td>
                <td>{entry.durationMs} ms</td>
                <td>
                  <details>
                    <summary>查看入参 / 返回</summary>
                    <p>请求编号：{entry.requestId}</p>
                    <h3>入参</h3>
                    <pre>{JSON.stringify(entry.request, null, 2)}</pre>
                    <h3>返回</h3>
                    <pre>{JSON.stringify(entry.response, null, 2)}</pre>
                    {entry.error != null && (
                      <>
                        <h3>错误</h3>
                        <pre>{JSON.stringify(entry.error, null, 2)}</pre>
                      </>
                    )}
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!entries.length && (
        <p className="log-empty">
          {range ? '此时间范围内没有匹配的调用记录。' : '输入日志访问密钥后查询。访问密钥仅保留在当前页面内存。'}
        </p>
      )}
      {cursor && (
        <button className="secondary" disabled={loading} onClick={() => void query(cursor)}>
          加载更早记录
        </button>
      )}
    </main>
  )
}
