import { randomUUID } from 'node:crypto'

import { expect, test, vi } from 'vitest'

import type { GameUser, RoomContext } from '@lights/contracts'

import { Rooms } from '../src/rooms'
import type { Repository } from '../src/storage'

const textContext: RoomContext = { type: 1, id: 'text-channel' }
const voiceContext: RoomContext = { type: 2, id: 'voice-channel' }
function player(): GameUser {
  return { id: randomUUID(), nickname: '点灯伙伴', completedRounds: 0, totalMoves: 0 }
}
function fixture() {
  const changed = vi.fn()
  const rooms = new Rooms({ settle: vi.fn() } as unknown as Repository, 4, 100, vi.fn(), changed)
  return { rooms, changed }
}

test('大厅按可信上下文分组，其他上下文只公开摘要，不泄漏棋盘、身份或实例', async () => {
  const { rooms } = fixture()
  const a = player(),
    b = player(),
    viewer = player()
  const own = rooms.create(a, 'instance-text', textContext)
  const other = rooms.create(b, 'instance-voice', voiceContext)
  const lobby = rooms.lobby(textContext, viewer.id, true)
  expect(lobby.rooms.map((r) => [r.id, r.isCurrentContext, r.canJoin])).toEqual([
    [own.id, true, true],
    [other.id, false, false],
  ])
  expect(lobby.canCreate).toBe(false)
  expect(JSON.stringify(lobby)).not.toMatch(/round|board|seed|instance-text|instance-voice/)
  expect(JSON.stringify(lobby)).not.toContain(a.id)
  await expect(rooms.join(other.id, viewer, 'instance-text', textContext)).rejects.toMatchObject({
    code: 'CONTEXT_MISMATCH',
  })
  // 服务端核验过的定向邀请保留跨上下文直接入房能力。
  expect((await rooms.join(other.id, viewer, null, textContext, true)).id).toBe(other.id)
})

test('同时建房仅一个成功；同上下文不同实例可加入，满员后才能新建，断线也占位', async () => {
  const { rooms } = fixture()
  const users = Array.from({ length: 6 }, player)
  const results = await Promise.allSettled(
    users.slice(0, 2).map((u) => Promise.resolve().then(() => rooms.create(u, 'instance-a', textContext)))
  )
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'CONTEXT_ROOM_AVAILABLE' } })
  const room = rooms.forUser(users[0].id)!
  for (let i = 1; i < 4; i++) await rooms.join(room.id, users[i], 'new-instance', textContext)
  expect(rooms.lobby(textContext, users[4].id, true).canCreate).toBe(true)
  const second = rooms.create(users[4], 'instance-a', textContext)
  await expect(rooms.join(room.id, users[5], 'instance-a', textContext)).rejects.toMatchObject({ code: 'ROOM_FULL' })
  rooms.connect(users[1].id, 'connection')
  rooms.disconnect(users[1].id, 'connection')
  expect(rooms.snapshot(room.id)!.players).toHaveLength(4)
  await rooms.leave(second.id, users[4].id)
  expect(rooms.lobby(textContext, users[5].id, true).canCreate).toBe(true)
  await rooms.leave(room.id, users[1].id)
  expect(rooms.lobby(textContext, users[5].id, true).canCreate).toBe(false)
  expect(() => rooms.create(users[5], 'instance-a', textContext)).toThrow('当前上下文还有空位')
})

test('准备、在线、开局、离房与超时清理更新大厅，棋盘操作无需重复推送摘要', async () => {
  const { rooms, changed } = fixture()
  const a = player(),
    b = player()
  const room = rooms.create(a, 'instance', voiceContext)
  const initialRevision = rooms.lobby(voiceContext, b.id, true).revision
  rooms.connect(a.id, 'connection')
  await rooms.handle(
    a.id,
    'connection',
    { type: 'room.ready', roomId: room.id, actionId: randomUUID(), ready: true },
    true
  )
  let lobby = rooms.lobby(voiceContext, b.id, true)
  expect(lobby.revision).toBeGreaterThan(initialRevision)
  expect(lobby.rooms[0].players[0]).toMatchObject({ online: true, ready: true })
  await rooms.handle(
    a.id,
    'connection',
    { type: 'round.start', roomId: room.id, actionId: randomUUID(), seed: 42 },
    true
  )
  expect(rooms.lobby(voiceContext, b.id, true).rooms[0].status).toBe('playing')
  const count = changed.mock.calls.length
  const snapshot = rooms.snapshot(room.id)!
  await rooms.handle(
    a.id,
    'connection',
    {
      type: 'board.toggle',
      roomId: room.id,
      actionId: randomUUID(),
      roundId: snapshot.round!.id,
      expectedVersion: snapshot.version,
      cell: 0,
    },
    true
  )
  expect(changed.mock.calls.length).toBe(count)
  rooms.disconnect(a.id, 'connection')
  expect(rooms.lobby(voiceContext, b.id, true).rooms[0].players[0]).toMatchObject({ online: false, ready: false })
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 200)
  try {
    await rooms.sweep()
  } finally {
    vi.restoreAllMocks()
  }
  lobby = rooms.lobby(voiceContext, b.id, true)
  expect(lobby.rooms).toEqual([])
  expect(lobby.canCreate).toBe(true)
})
