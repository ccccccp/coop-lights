import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { getConfig } from '../src/config'
import { isOAuthConfigured } from '../src/platform'

beforeEach(() => {
  vi.stubEnv('DATABASE_URL', 'postgresql://config-test:config-test@127.0.0.1:55432/config-test')
  vi.stubEnv('SERVER_HTTPS', 'false')
  vi.stubEnv('KOOK_API_ORIGIN', undefined)
  vi.stubEnv('KOOK_CLIENT_ID', 'config-test')
  vi.stubEnv('KOOK_CLIENT_SECRET', 'config-test-secret')
  vi.stubEnv('KOOK_REDIRECT_URI', 'https://game.test/')
})

afterEach(() => vi.unstubAllEnvs())

test.each([undefined, 'https://staging.test:8443'])('服务环境 %s 的换码、资料和邀请请求使用同一个 origin', (origin) => {
  vi.stubEnv('KOOK_API_ORIGIN', origin)
  const config = getConfig().kook
  const expectedOrigin = origin ?? 'https://www.kookapp.cn'
  expect(config.tokenUrl).toBe(`${expectedOrigin}/api/oauth2/token`)
  expect(config.userInfoUrl).toBe(`${expectedOrigin}/api/v3/user/me`)
  expect(config.contextUrl).toBe(`${expectedOrigin}/api/v3/mini-game/context`)
  expect(isOAuthConfigured(config)).toBe(true)
})

test.each([
  'not-a-url',
  'http://staging.test',
  'https://staging.test/api',
  'https://staging.test/',
  'https://staging.test?target=other',
  'https://staging.test#other',
  'https://user:password@staging.test',
])('拒绝不合法的 KOOK 服务 origin：%s', (origin) => {
  vi.stubEnv('KOOK_API_ORIGIN', origin)
  expect(() => getConfig()).toThrow('KOOK_API_ORIGIN')
})

test('缺少应用密钥时不开放 OAuth 登录', () => {
  vi.stubEnv('KOOK_CLIENT_SECRET', '')
  expect(isOAuthConfigured(getConfig().kook)).toBe(false)
})
