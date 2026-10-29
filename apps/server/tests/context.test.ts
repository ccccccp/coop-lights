import { afterEach, expect, test, vi } from 'vitest'

import type { Config } from '../src/config'
import { exchangeKookCode, readKookContext } from '../src/platform'

const config: Config['kook'] = {
  clientId: 'test-client',
  clientSecret: 'secret-only-on-server',
  redirectUri: 'https://game.test/',
  tokenUrl: 'https://kook.test/api/oauth2/token',
  userInfoUrl: 'https://kook.test/api/v3/user/me',
  gameCode: 'lights-sdk-fixture',
  contextUrl: 'https://kook.test/api/v3/mini-game/context',
}
const accessToken = 'server-access-token'
const valid = {
  game_code: 'lights-sdk-fixture',
  instance: { instance_id: 'instance', state: 'active', context_type: 4, context_id: 'private-chat' },
  invite: { status: 'joined_by_invite' },
  room: { room_id: 'ABC234', room_source: 'invite' },
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
  const result = await exchangeKookCode(config, 'code-once').then((grant) =>
    readKookContext(config, grant.accessToken, 'instance')
  )
  expect(result).toEqual({ instanceId: 'instance', invitedRoomId: 'ABC234' })
  const url = new URL(String(fetcher.mock.calls[2][0]))
  expect(url.pathname).toBe('/api/v3/mini-game/context')
  expect(Object.fromEntries(url.searchParams)).toEqual({ game_code: config.gameCode, instance_id: 'instance' })
  expect(fetcher.mock.calls[2][1].headers.Authorization).toBe(`Bearer ${accessToken}`)
  expect(JSON.stringify(result)).not.toContain(accessToken)
  expect(JSON.stringify(result)).not.toContain(config.clientSecret)
})

test('普通进入的instance回退房间保持主页，不按点灯六位房间号校验或加入', async () => {
  mock({
    code: 0,
    data: { ...valid, invite: { status: 'none' }, room: { room_source: 'instance', room_id: 'instance' } },
  })
  const result = await exchangeKookCode(config, 'code-once').then((grant) =>
    readKookContext(config, grant.accessToken, 'instance')
  )
  expect(result).toEqual({ instanceId: 'instance', invitedRoomId: null })
})

test.each([
  { ...valid, instance: { ...valid.instance, instance_id: 'foreign' } },
  { ...valid, game_code: 'other-game' },
  { ...valid, room: { room_source: 'invite', room_id: '../other' } },
  { ...valid, room: { room_source: 'invite', room_id: 123456 } },
  { ...valid, instance: { ...valid.instance, context_type: 0 } },
])('错误context不允许建立可信实例绑定：%j', async (context) => {
  mock({ code: 0, data: context })
  await expect(
    exchangeKookCode(config, 'code-once').then((grant) => readKookContext(config, grant.accessToken, 'instance'))
  ).rejects.toMatchObject({
    code: 'PLATFORM_CONTEXT_INVALID',
  })
})

test('context接口无权限时不退回浏览器房间，错误不会泄漏OAuth token', async () => {
  mock({ code: 403, message: `Missing mini_game.context; Bearer ${accessToken}` }, 403)
  let failure: unknown
  try {
    await exchangeKookCode(config, 'code-once').then((grant) => readKookContext(config, grant.accessToken, 'instance'))
  } catch (error) {
    failure = error
  }
  expect(failure).toMatchObject({ code: 'PLATFORM_LOGIN_FAILED', details: { stage: 'context', http_status: 403 } })
  expect(JSON.stringify(failure)).not.toContain(accessToken)
})

test('嵌套实例不匹配返回精确字段路径，不回显用户资料或凭据', async () => {
  mock({
    code: 0,
    data: {
      game_code: config.gameCode,
      instance: { instance_id: 'foreign', state: 'active', context_type: 4, context_id: 'private-chat' },
      invite: { status: 'joined_by_invite' },
      room: { room_id: 'ABC234', room_source: 'invite' },
      user: { user_code: 'private-user-code' },
      access_token: accessToken,
      client_secret: config.clientSecret,
    },
  })
  let failure: unknown
  try {
    await exchangeKookCode(config, 'private-auth-code').then((grant) =>
      readKookContext(config, grant.accessToken, 'instance')
    )
  } catch (error) {
    failure = error
  }
  expect(failure).toMatchObject({
    code: 'PLATFORM_CONTEXT_INVALID',
    details: {
      stage: 'context',
      endpoint: config.contextUrl,
      http_status: 200,
      invalid_fields: ['instance.instance_id'],
      received_types: { game_code: 'string', instance: 'object', invite: 'object', room: 'object' },
    },
  })
  expect(JSON.stringify(failure)).not.toContain(accessToken)
  expect(JSON.stringify(failure)).not.toContain(config.clientSecret)
  expect(JSON.stringify(failure)).not.toContain('private-user-code')
  expect(JSON.stringify(failure)).not.toContain('private-auth-code')
})

test('旧版缺少room结构时给出精确失败字段，不能用旧平铺room_id冒充', async () => {
  const { room: _room, ...withoutRoom } = valid
  mock({ code: 0, data: { ...withoutRoom, room_id: 'ABC234' } })
  await expect(
    exchangeKookCode(config, 'once-code').then((grant) => readKookContext(config, grant.accessToken, 'instance'))
  ).rejects.toMatchObject({ code: 'PLATFORM_CONTEXT_INVALID', details: { invalid_fields: ['room'] } })
})

test('未通过实例校验的平铺字段不能覆盖嵌套响应，也不读取SDK或URL房间号', async () => {
  mock({
    code: 0,
    data: {
      ...valid,
      instance: { ...valid.instance, instance_id: 'foreign' },
      instance_id: 'instance',
      room_id: 'ABC234',
    },
  })
  await expect(
    exchangeKookCode(config, 'once-code').then((grant) => readKookContext(config, grant.accessToken, 'instance'))
  ).rejects.toMatchObject({ code: 'PLATFORM_CONTEXT_INVALID', details: { invalid_fields: ['instance.instance_id'] } })
})
test('普通加入即使返回room_id也不擅自触发邀请入房', async () => {
  mock({ code: 0, data: { ...valid, invite: { status: 'none' } } })
  expect(
    (
      await exchangeKookCode(config, 'once-code').then((grant) =>
        readKookContext(config, grant.accessToken, 'instance')
      )
    ).invitedRoomId
  ).toBeNull()
})

test('只消费正式room对象，旧平铺字段和invite.room_id不能覆盖它', async () => {
  mock({ code: 0, data: { ...valid, room_id: 'FAKE22', invite: { status: 'joined_by_invite', room_id: 'FAKE33' } } })
  expect(
    (
      await exchangeKookCode(config, 'once-code').then((grant) =>
        readKookContext(config, grant.accessToken, 'instance')
      )
    ).invitedRoomId
  ).toBe('ABC234')
})

test.each([
  { room_source: 'invite', room_id: '' },
  { room_source: 'invite', room_id: null },
  { room_source: 'invite' },
  { room_source: 'instance', room_id: 'other-instance' },
  { room_source: 'unsupported', room_id: 'ABC234' },
])('错误room内容拒绝接受邀请：%j', async (room) => {
  mock({ code: 0, data: { ...valid, room } })
  await expect(
    exchangeKookCode(config, 'once-code').then((grant) => readKookContext(config, grant.accessToken, 'instance'))
  ).rejects.toMatchObject({ code: 'PLATFORM_CONTEXT_INVALID' })
})

test('即使邀请状态为joined_by_invite，instance来源也不能当作游戏房间', async () => {
  mock({ code: 0, data: { ...valid, room: { room_source: 'instance', room_id: 'instance' } } })
  expect(
    (
      await exchangeKookCode(config, 'once-code').then((grant) =>
        readKookContext(config, grant.accessToken, 'instance')
      )
    ).invitedRoomId
  ).toBeNull()
})
