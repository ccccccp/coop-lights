import { useEffect, useRef, useState } from 'react'

import type { PlatformAdapter, PlatformContext } from '@lights/contracts'

import './index.css'

interface Props {
  adapter?: PlatformAdapter | null
  platform?: PlatformContext | null
  disabled?: boolean
}

export function ExternalLinkTest({ adapter, platform, disabled = false }: Props) {
  const [url, setUrl] = useState('')
  const [opening, setOpening] = useState(false)
  const [result, setResult] = useState<{ error: boolean; message: string } | null>(null)
  const pending = useRef(false)
  const generation = useRef(0)
  const supported = !!platform?.capabilities.includes('ui.openExternalLink') && !!adapter?.openExternalLink
  const ready = platform?.status === 'ready'
  useEffect(() => {
    generation.current++
    pending.current = false
    setOpening(false)
    setResult(null)
    return () => {
      generation.current++
    }
  }, [adapter, platform?.epoch, platform?.status])

  async function open() {
    if (pending.current || !adapter?.openExternalLink || !supported || !ready || disabled || !url.trim()) return
    pending.current = true
    const attempt = generation.current
    setOpening(true)
    setResult(null)
    try {
      await adapter.openExternalLink(url.trim())
      if (attempt === generation.current)
        setResult({ error: false, message: '已请求 KOOK 打开外链，请在新页面查看跳转结果。' })
    } catch (error) {
      if (attempt === generation.current)
        setResult({ error: true, message: `打开失败：${error instanceof Error ? error.message : '请稍后重试'}` })
    } finally {
      if (attempt === generation.current) {
        pending.current = false
        setOpening(false)
      }
    }
  }

  return (
    <form
      className="sdk-external-link-test"
      aria-label="外链跳转测试"
      onSubmit={(event) => {
        event.preventDefault()
        void open()
      }}
    >
      <h2>外链跳转测试</h2>
      <p>通过 KOOK 打开外链，保留宿主的跳转提示和风险检查。</p>
      <label>
        外链地址
        <input
          aria-label="外链地址"
          value={url}
          inputMode="url"
          maxLength={2048}
          disabled={opening}
          placeholder="https://example.com/help"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setUrl(event.target.value)
            setResult(null)
          }}
        />
      </label>
      <button
        className="primary"
        type="submit"
        disabled={disabled || opening || !ready || !supported || !url.trim()}
        aria-busy={opening}
      >
        {opening ? '正在打开…' : '打开外链'}
      </button>
      {!supported && (
        <p className="sdk-external-link-hint">
          {platform?.mode === 'standalone'
            ? '请从 KOOK 打开游戏后测试外链跳转。'
            : ready
              ? '当前 KOOK 宿主尚未开放外链能力。'
              : '等待 KOOK 连接就绪。'}
        </p>
      )}
      {result && (
        <p
          className={result.error ? 'sdk-external-link-error' : 'sdk-external-link-success'}
          role={result.error ? 'alert' : 'status'}
        >
          {result.message}
        </p>
      )}
    </form>
  )
}
