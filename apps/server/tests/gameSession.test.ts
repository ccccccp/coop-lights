import { afterEach, expect, test, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

async function fixture() {
  vi.resetModules()
  const fetcher = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', fetcher)
  const module = await import('../../web/src/api')
  return { ...module, fetcher }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('注销失败保留当前凭证供重试，旧注销回包不能清除新登录', async () => {
  const f = await fixture()
  f.setGameToken('a'.repeat(64))
  f.fetcher.mockRejectedValueOnce(new Error('offline'))
  await expect(f.api.logout()).rejects.toThrow('offline')
  f.fetcher.mockResolvedValueOnce(Response.json({ user: {} }))
  await f.api.session()
  expect(new Headers(f.fetcher.mock.calls[1][1]!.headers).get('Authorization')).toBe(`Bearer ${'a'.repeat(64)}`)
  const pending = deferred<Response>()
  f.fetcher.mockReturnValueOnce(pending.promise)
  const work = f.api.logout()
  f.setGameToken('b'.repeat(64))
  pending.resolve(Response.json({ ok: true }))
  await work
  f.fetcher.mockResolvedValueOnce(Response.json({ user: {} }))
  await f.api.session()
  expect(new Headers(f.fetcher.mock.calls[3][1]!.headers).get('Authorization')).toBe(`Bearer ${'b'.repeat(64)}`)
})

test('关闭先捕获注销操作，清空页面内存后仍可撤销旧游戏会话', async () => {
  const f = await fixture()
  f.setGameToken('a'.repeat(64))
  const cleanup = f.api.prepareLogout()
  f.setGameToken(null)
  f.fetcher.mockResolvedValueOnce(Response.json({ ok: true }))
  await cleanup()
  expect(new Headers(f.fetcher.mock.calls[0][1]!.headers).get('Authorization')).toBe(`Bearer ${'a'.repeat(64)}`)
  f.fetcher.mockResolvedValueOnce(Response.json({}))
  await f.api.session()
  expect(new Headers(f.fetcher.mock.calls[1][1]!.headers).has('Authorization')).toBe(false)
})

test('原登录路由使用同一个随机nonce，取消后移除对应内存凭证', async () => {
  const f = await fixture()
  const state = 'c'.repeat(64)
  f.fetcher.mockResolvedValueOnce(Response.json({ state }))
  await f.api.beginKookLogin()
  const started = JSON.parse(String(f.fetcher.mock.calls[0][1]!.body))
  expect(started.clientNonce).toMatch(/^[a-f0-9]{64}$/)
  f.fetcher.mockResolvedValueOnce(Response.json({ user: {}, gameToken: 'a'.repeat(64) }))
  await f.api.completeKookLogin('one-use-code', state)
  const completed = JSON.parse(String(f.fetcher.mock.calls[1][1]!.body))
  expect(completed.clientNonce).toBe(started.clientNonce)
  expect(f.fetcher.mock.calls[1][0]).toBe('/api/kook/login/complete')
  f.setGameToken('a'.repeat(64), state)
  f.fetcher.mockResolvedValueOnce(Response.json({ ok: true }))
  await f.api.cancelKookLogin(state)
  const cancelled = JSON.parse(String(f.fetcher.mock.calls[2][1]!.body))
  expect(cancelled.clientNonce).toBe(started.clientNonce)
  f.fetcher.mockResolvedValueOnce(Response.json({}))
  await f.api.session()
  expect(new Headers(f.fetcher.mock.calls[3][1]!.headers).has('Authorization')).toBe(false)
})

test('清理迟到换码会话不携带Cookie，也不覆盖当前内存凭证', async () => {
  const f = await fixture()
  f.setGameToken('b'.repeat(64))
  f.fetcher.mockResolvedValueOnce(Response.json({ ok: true }))
  await f.api.revokeGameToken('a'.repeat(64))
  expect(f.fetcher.mock.calls[0][1]!.credentials).toBe('omit')
  expect(new Headers(f.fetcher.mock.calls[0][1]!.headers).get('Authorization')).toBe(`Bearer ${'a'.repeat(64)}`)
  f.fetcher.mockResolvedValueOnce(Response.json({}))
  await f.api.session()
  expect(new Headers(f.fetcher.mock.calls[1][1]!.headers).get('Authorization')).toBe(`Bearer ${'b'.repeat(64)}`)
})
