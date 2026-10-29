import { afterEach, expect, test, vi } from 'vitest'

import type { Config } from '../src/config'
import { exchangeKookCode } from '../src/platform'

const config: Config['kook'] = {
  clientId: 'test-client',
  clientSecret: 'secret-only-on-server',
  redirectUri: 'https://game.test/',
  tokenUrl: 'https://kook.test/api/oauth2/token',
  userInfoUrl: 'https://kook.test/api/v3/user/me',
  userIdField: 'id',
  userNameField: 'username',
  gameCode: 'lights-sdk-fixture',
  contextUrl: 'https://kook.test/api/v3/mini-game/context',
}
const accessToken = 'server-access-token'
const valid = {
  game_code: 'lights-sdk-fixture',
  instance_id: 'instance',
  context_type: 4,
  context_id: 'private-chat',
  room_id: 'ABC234',
  invite_status: 'joined_by_invite',
}
afterEach(() => vi.unstubAllGlobals())
function mock(data: unknown, status = 200) {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ access_token: accessToken, token_type: 'Bearer', expires_in: 3600 }))
    .mockResolvedValueOnce(Response.json({ code: 0, data: { id: 'user', username: '玩家' } }))
    .mockResolvedValueOnce(Response.json(data, { status }))
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}

test('同一OAuth token在后端查询真实context，room_id和实例核验成功才返回启动信息', async () => {
  const fetcher = mock({ code: 0, data: valid })
  const result = await exchangeKookCode(config, 'code-once', 'instance')
  expect(result.launch).toEqual({ instanceId: 'instance', invitedRoomId: 'ABC234' })
  const url = new URL(String(fetcher.mock.calls[2][0]))
  expect(url.pathname).toBe('/api/v3/mini-game/context')
  expect(Object.fromEntries(url.searchParams)).toEqual({ game_code: config.gameCode, instance_id: 'instance' })
  expect(fetcher.mock.calls[2][1].headers.Authorization).toBe(`Bearer ${accessToken}`)
  expect(JSON.stringify(result)).not.toContain(accessToken)
  expect(JSON.stringify(result)).not.toContain(config.clientSecret)
})

test.each([null, '', undefined])('context room_id为%j时保持主页，不猜测邀请房间', async (roomId) => {
  mock({ code: 0, data: { ...valid, room_id: roomId } })
  expect((await exchangeKookCode(config, 'code-once', 'instance')).launch?.invitedRoomId).toBeNull()
})

test.each([
  { ...valid, instance_id: 'foreign' },
  { ...valid, game_code: 'other-game' },
  { ...valid, room_id: '../other' },
  { ...valid, room_id: 123456 },
  { ...valid, context_type: 0 },
])('错误context不允许建立可信实例绑定：%j', async (context) => {
  mock({ code: 0, data: context })
  await expect(exchangeKookCode(config, 'code-once', 'instance')).rejects.toMatchObject({
    code: 'PLATFORM_CONTEXT_INVALID',
  })
})

test('context接口无权限时不退回浏览器房间，错误不会泄漏OAuth token', async () => {
  mock({ code: 403, message: `Missing mini_game.context; Bearer ${accessToken}` }, 403)
  let failure: unknown
  try {
    await exchangeKookCode(config, 'code-once', 'instance')
  } catch (error) {
    failure = error
  }
  expect(failure).toMatchObject({ code: 'PLATFORM_LOGIN_FAILED', details: { stage: 'context', http_status: 403 } })
  expect(JSON.stringify(failure)).not.toContain(accessToken)
})
