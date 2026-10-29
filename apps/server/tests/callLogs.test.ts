import { expect, test } from 'vitest'

import { type CallLogInput, createCallLogStore, safeRequest, sanitizeCallData } from '../src/callLogs'

test('入库前清除请求、响应与回显文本中的凭据，保留业务码和room_id结构', () => {
  const entry = {
    request: {
      body: { code: 'secret-code', client_secret: 'secret-client', state: 'secret-state' },
      query: { game_code: 'game' },
    },
    response: {
      code: 0,
      data: { access_token: 'secret-token', room_id: 'ABC234' },
      message: 'secret-code; Bearer secret-token; secret-client',
    },
  }
  const cleaned = sanitizeCallData(entry)
  expect(JSON.stringify(cleaned)).not.toMatch(/secret-code|secret-client|secret-state|secret-token/)
  expect(cleaned).toMatchObject({
    response: { code: 0, data: { room_id: 'ABC234', access_token: '[REDACTED]' } },
    request: { query: { game_code: 'game' } },
  })
})
test('请求提取保留URL参数与表单入参，endpoint不包含敏感query', () => {
  const data = safeRequest(
    'https://kook.test/api/token?state=private-state',
    new URLSearchParams({ code: 'private-code', client_id: 'client' })
  )
  expect(data.endpoint).toBe('https://kook.test/api/token')
  expect(sanitizeCallData({ request: data.request })).toEqual({
    request: { query: { state: '[REDACTED]' }, body: { code: '[REDACTED]', client_id: 'client' } },
  })
})
test('日志持久化失败不阻断业务，写入在排队前已脱敏', async () => {
  const saved: CallLogInput[] = []
  let warnings = 0
  const store = createCallLogStore(
    {
      saveCallLog: async (entry) => {
        saved.push(entry)
        throw Error('db-down')
      },
    },
    () => {
      warnings++
    }
  )
  await store.recorder('request')({
    method: 'POST',
    endpoint: 'https://kook.test/api/token',
    startedAt: Date.now(),
    durationMs: 1,
    status: 200,
    ok: true,
    request: { code: 'private-code' },
    response: { access_token: 'private-token' },
  })
  await store.flush()
  expect(warnings).toBe(1)
  expect(JSON.stringify(saved)).not.toMatch(/private-code|private-token/)
})

test('KOOK实例业务state和participant_state保留，OAuth事务state及其回显仍脱敏', () => {
  const cleaned = sanitizeCallData({
    request: { body: { state: 'opaque-oauth-state' } },
    response: {
      data: { instance: { state: 'active' }, user: { participant_state: 'active' } },
      state: 'oauth-code-response-state',
      message: 'opaque-oauth-state',
    },
  })
  expect(cleaned).toMatchObject({
    request: { body: { state: '[REDACTED]' } },
    response: {
      data: { instance: { state: 'active' }, user: { participant_state: 'active' } },
      state: '[REDACTED]',
      message: '[REDACTED]',
    },
  })
})
