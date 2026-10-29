import { afterEach, expect, test, vi } from 'vitest'

import type { Config } from '../src/config'
import { GameError } from '../src/errors'
import { exchangeKookCode } from '../src/platform'

const config: Config['kook'] = {
  clientId: 'test-client',
  clientSecret: 'private-client-secret',
  redirectUri: 'https://game.test/',
  tokenUrl: 'https://kook.test/api/oauth2/token',
  userInfoUrl: 'https://kook.test/api/v3/user/me',
  gameCode: 'lights-sdk-fixture',
  contextUrl: 'https://kook.test/api/v3/mini-game/context',
  userIdField: 'id',
  userNameField: 'username',
}
const code = 'private-authorization-code'
const accessToken = 'private-access-token'
const token = () => Response.json({ access_token: accessToken, token_type: 'Bearer', expires_in: 3600 })

afterEach(() => vi.unstubAllGlobals())

async function exchangeFailure() {
  try {
    await exchangeKookCode(config, code)
  } catch (error) {
    expect(error).toBeInstanceOf(GameError)
    return error as GameError
  }
  throw new Error('Expected exchange failure')
}

test('换码 HTTP 错误保留 OAuth 原因，并过滤回显的密钥、授权码及请求参数', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      Response.json(
        {
          error: 'invalid_grant',
          error_description: `Redirect URI mismatch; ${config.clientSecret}; ${code}; access_token=unrelated-token`,
        },
        { status: 400 }
      )
    )
  )
  const error = await exchangeFailure()
  expect(error.details).toMatchObject({
    stage: 'token',
    endpoint: config.tokenUrl,
    http_status: 400,
    upstream_code: 'invalid_grant',
  })
  expect(error.message).toContain('Redirect URI mismatch')
  expect(error.message).toContain('HTTP 400')
  expect(JSON.stringify(error)).not.toContain(config.clientSecret)
  expect(JSON.stringify(error)).not.toContain(code)
  expect(JSON.stringify(error)).not.toContain('unrelated-token')
})

test('用户资料 HTTP 错误标明 userinfo，Bearer 凭证不出现在错误中', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(
        Response.json(
          {
            code: 40101,
            message: `Token rejected: Bearer ${accessToken}`,
          },
          { status: 401 }
        )
      )
  )
  const error = await exchangeFailure()
  expect(error.details).toMatchObject({
    stage: 'userinfo',
    endpoint: config.userInfoUrl,
    http_status: 401,
    upstream_code: 40101,
  })
  expect(error.message).toContain('Token rejected')
  expect(error.message).toContain('KOOK 用户信息请求失败')
  expect(JSON.stringify(error)).not.toContain(accessToken)
})

test('HTTP 成功但 KOOK 业务拒绝时仍返回上游业务码和原因', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(
        Response.json({
          code: 40301,
          message: 'Missing get_user_info scope',
        })
      )
  )
  const error = await exchangeFailure()
  expect(error.details).toMatchObject({ stage: 'userinfo', http_status: 200, upstream_code: 40301 })
  expect(error.message).toContain('Missing get_user_info scope')
})

test('非 JSON 网关错误保留阶段和 HTTP 状态，不返回原始 HTML', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>private proxy details</html>', { status: 502 })))
  const error = await exchangeFailure()
  expect(error.details).toMatchObject({ stage: 'token', http_status: 502 })
  expect(error.message).toContain('上游响应不是有效 JSON')
  expect(JSON.stringify(error)).not.toContain('private proxy details')
})

test.each(['ENOTFOUND', 'ECONNREFUSED', 'CERT_HAS_EXPIRED'])('网络错误返回 %s，不透传原始异常', async (networkCode) => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError(`private ${code}`, { cause: { code: networkCode } })))
  const error = await exchangeFailure()
  expect(error.details).toEqual({ stage: 'token', endpoint: config.tokenUrl, network_code: networkCode })
  expect(error.message).toContain(networkCode)
  expect(JSON.stringify(error)).not.toContain(code)
})

test('超时与 HTTP 错误可区分', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('timeout', 'TimeoutError')))
  const error = await exchangeFailure()
  expect(error.details).toMatchObject({ stage: 'token', network_code: 'TIMEOUT' })
  expect(error.message).toContain('请求超时')
})

test('换码响应格式错误只公开错误字段名', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ access_token: accessToken })))
  const error = await exchangeFailure()
  expect(error.code).toBe('PLATFORM_RESPONSE_INVALID')
  expect(error.details).toMatchObject({
    stage: 'token',
    http_status: 200,
    invalid_fields: ['token_type', 'expires_in'],
  })
  expect(JSON.stringify(error)).not.toContain(accessToken)
})

test('用户资料字段错误返回配置中的实际字段名', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(
        Response.json({
          code: 0,
          data: { id: 123, username: '' },
        })
      )
  )
  const error = await exchangeFailure()
  expect(error.details).toMatchObject({ stage: 'userinfo', invalid_fields: ['id', 'username'] })
})

test('成功换码和用户资料解析保持原有行为', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(
        Response.json({
          code: 0,
          data: { id: 'user-1', username: '玩家', avatar: 'https://cdn.test/avatar.png' },
        })
      )
  )
  const result = await exchangeKookCode(config, code)
  expect(result.identity).toEqual({
    appId: config.clientId,
    openCode: 'user-1',
    nickname: '玩家',
    avatarUrl: 'https://cdn.test/avatar.png',
  })
  expect(result.expiresAt).toBeGreaterThan(Date.now())
})
