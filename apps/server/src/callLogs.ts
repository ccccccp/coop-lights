import { randomUUID } from 'node:crypto'

export interface CallLogInput {
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
export interface CallLog extends CallLogInput {
  id: string
}
export interface CallLogQuery {
  from: number
  to: number
  kind?: 'game' | 'kook'
  errorsOnly?: boolean
  search?: string
  cursor?: { startedAt: number; id: string }
  limit: number
}
export interface CallLogRepository {
  saveCallLog?(entry: CallLogInput): Promise<void>
  listCallLogs?(query: CallLogQuery): Promise<CallLog[]>
  pruneCallLogs?(before: number): Promise<void>
}
export type CallRecorder = (entry: Omit<CallLogInput, 'requestId' | 'kind'>, secrets?: string[]) => Promise<void>

const sensitive = new Set([
  'authorization',
  'cookie',
  'setcookie',
  'accesstoken',
  'refreshtoken',
  'clientsecret',
  'authcode',
  'code',
  'state',
  'clientnonce',
  'gametoken',
  'ticket',
  'password',
  'secret',
  'logaccesskey',
  'xlogkey',
])
const normalize = (key: string) => key.replace(/[_-]/g, '').toLowerCase()

/** 在入库前脱敏；不持久化原始凭据，即使它们被上游回显到任意字符串。 */
export function sanitizeCallData(value: unknown, extraSecrets: string[] = []): unknown {
  const secrets = new Set(extraSecrets.filter(Boolean))
  function isSecret(key: string, path: string) {
    // KOOK实例的state是业务状态；OAuth事务state仍必须脱敏。
    if (normalize(key) === 'state' && ['response.data.instance', 'response.instance'].includes(path)) return false
    return (
      (sensitive.has(normalize(key)) && normalize(key) !== 'code') ||
      (normalize(key) === 'code' && !path.startsWith('response'))
    )
  }
  function collect(item: unknown, depth = 0, path = '') {
    if (!item || typeof item !== 'object' || depth > 8) return
    for (const [key, child] of Object.entries(item).slice(0, 100)) {
      if (isSecret(key, path) && typeof child === 'string' && child) {
        secrets.add(child)
        const bearer = /^(?:Bearer|Official|Bot)\s+(.+)$/i.exec(child)
        if (bearer) secrets.add(bearer[1])
      } else collect(child, depth + 1, path ? path + '.' + key : key)
    }
  }
  collect(value)
  const variants = [...secrets]
    .flatMap((secret) => [secret, encodeURIComponent(secret)])
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
  function text(input: string) {
    let result = input
    for (const secret of variants) result = result.split(secret).join('[REDACTED]')
    return result
      .replace(/\b(?:Bearer|Official|Bot)\s+[^\s"',;]+/gi, '[REDACTED]')
      .replace(
        /((?:access_token|refresh_token|client_secret|auth_code|authorization|password)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi,
        '$1[REDACTED]'
      )
      .slice(0, 8000)
  }
  function visit(item: unknown, depth = 0, path = ''): unknown {
    if (depth > 8) return '[TRUNCATED]'
    if (typeof item === 'string') return text(item)
    if (item == null || typeof item === 'number' || typeof item === 'boolean') return item ?? null
    if (item instanceof Error) return { name: item.name, message: text(item.message) }
    if (Array.isArray(item)) return item.slice(0, 50).map((child) => visit(child, depth + 1, path))
    if (typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .slice(0, 100)
          .map(([key, child]) => [
            key,
            isSecret(key, path) && typeof child !== 'number'
              ? '[REDACTED]'
              : visit(child, depth + 1, path ? path + '.' + key : key),
          ])
      )
    return null
  }
  return visit(value)
}

export function safeRequest(url: string, body?: unknown) {
  const parsed = new URL(url, 'https://game.invalid')
  const query = Object.fromEntries(parsed.searchParams)
  let payload = body
  if (body instanceof URLSearchParams) payload = Object.fromEntries(body)
  else if (typeof body === 'string') {
    try {
      payload = JSON.parse(body)
    } catch {
      payload = Object.fromEntries(new URLSearchParams(body))
    }
  }
  return {
    endpoint: parsed.origin === 'https://game.invalid' ? parsed.pathname : parsed.origin + parsed.pathname,
    request: { query, body: payload ?? null },
  }
}

export function createCallLogStore(repo: CallLogRepository, warn: () => void, retentionDays = 7) {
  let tail = Promise.resolve()
  let queued = 0
  let lastPrune = 0
  const record = (entry: CallLogInput, secrets: string[] = []) => {
    if (!repo.saveCallLog || queued >= 500) return Promise.resolve()
    // 收集请求和响应内的敏感值后统一脱敏，防止跨字段回显泄漏。
    const cleaned = sanitizeCallData(entry, secrets) as CallLogInput
    queued++
    const task = tail
      .then(async () => {
        await repo.saveCallLog!(cleaned)
        if (Date.now() - lastPrune > 3600000) {
          lastPrune = Date.now()
          await repo.pruneCallLogs?.(Date.now() - retentionDays * 86400000)
        }
      })
      .catch(warn)
      .finally(() => {
        queued--
      })
    tail = task
    return task
  }
  return {
    record,
    recorder(requestId: string = randomUUID()): CallRecorder {
      return (entry, secrets) => record({ ...entry, requestId, kind: 'kook' }, secrets)
    },
    flush: () => tail,
  }
}
