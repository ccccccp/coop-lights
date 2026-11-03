import type { LobbyRoom, LobbySnapshot, RoomContext, RoomSnapshot } from '@lights/contracts'

import { UserAvatar } from '../UserAvatar'

const contextNames = { 1: '文字频道', 2: '语音频道', 3: '一对一私信', 4: '游戏应用私信' }
function contextLabel(context: RoomContext | null) {
  return context ? `${contextNames[context.type]} · ${context.id}` : '独立游戏大厅'
}
export function RoomLobby({
  lobby,
  room,
  busy,
  connected,
  kook,
  onCreate,
  onJoin,
  onResume,
  onLeave,
  onRefresh,
}: {
  lobby: LobbySnapshot | null
  room: RoomSnapshot | null
  busy: boolean
  connected: boolean
  kook: boolean
  onCreate: () => void
  onJoin: (id: string) => void
  onResume: () => void
  onLeave: () => void
  onRefresh: () => void
}) {
  const current = lobby?.rooms.filter((r) => r.isCurrentContext) ?? []
  const other = lobby?.rooms.filter((r) => !r.isCurrentContext) ?? []
  function card(r: LobbyRoom) {
    const own = room?.id === r.id
    const full = r.players.length >= r.maxPlayers
    return (
      <article
        className={`lobby-room-card ${r.isCurrentContext ? '' : 'readonly'}`}
        key={r.id}
        data-testid={`lobby-room-${r.id}`}
      >
        <div className="lobby-room-top">
          <strong>{r.hostName}的小队</strong>
          <span>{r.status === 'playing' ? '点灯中' : r.status === 'finished' ? '已通关' : '等待准备'}</span>
        </div>
        <p className="lobby-room-context">{contextLabel(r.context)}</p>
        <div className="lobby-room-players">
          {r.players.map((p, i) => (
            <div className="lobby-room-player" key={i}>
              <UserAvatar nickname={p.nickname} avatarUrl={p.avatarUrl} online={p.online} />
              <span>
                {p.nickname}
                <small>
                  {!p.online ? '等待重连' : r.status === 'playing' ? '游戏中' : p.ready ? '已准备' : '未准备'}
                </small>
              </span>
            </div>
          ))}
        </div>
        <div className="lobby-room-bottom">
          <span>
            {r.players.length} / {r.maxPlayers} 人{full ? ' · 已满员' : ''}
          </span>
          {own ? (
            <button className="secondary small" disabled={busy || !connected} onClick={onResume}>
              返回房间 →
            </button>
          ) : r.isCurrentContext ? (
            <button
              className="secondary small"
              disabled={busy || !connected || !!room || !r.canJoin}
              onClick={() => onJoin(r.id)}
            >
              {full ? '房间已满' : '加入房间 →'}
            </button>
          ) : (
            <span className="readonly-label">仅可查看</span>
          )}
        </div>
      </article>
    )
  }
  return (
    <section className="lobby" data-testid="room-lobby">
      <div className="section-heading">
        <p className="eyebrow">FIND YOUR NEXT LIGHT</p>
        <h1>
          房间大厅<span>。</span>
        </h1>
        <p>与当前上下文的伙伴一起点灯。</p>
      </div>
      <div className="lobby-toolbar">
        <div>
          <strong>{lobby ? contextLabel(lobby.context) : '正在读取房间信息…'}</strong>
          <p>
            {!connected
              ? '连接恢复后更新房间状态'
              : lobby
                ? '人数、准备和对局状态实时更新'
                : '暂未取得上下文，请刷新重试'}
          </p>
        </div>
        <button className="text-button" disabled={busy || !connected} onClick={onRefresh}>
          刷新大厅
        </button>
      </div>
      {room && (
        <div className="lobby-membership">
          <span>你已加入 {room.id} 房间，可以返回继续游玩。</span>
          <div>
            <button className="secondary small" disabled={busy || !connected} onClick={onResume}>
              返回房间 →
            </button>
            <button className="text-button" disabled={busy} onClick={onLeave}>
              离开房间
            </button>
          </div>
        </div>
      )}
      <div className="lobby-section-heading">
        <h2>
          {kook ? '当前上下文房间' : '可加入的房间'} <small>{current.length}</small>
        </h2>
        <button
          className="primary"
          data-testid="create-room"
          disabled={busy || !connected || !lobby?.canCreate}
          onClick={onCreate}
        >
          创建房间 ＋
        </button>
      </div>
      <p className="lobby-rule">
        {room
          ? '离开当前房间后，可以加入其他小队。'
          : !lobby
            ? '取得房间信息后，即可加入或创建小队。'
            : kook && current.some((r) => r.players.length < r.maxPlayers)
              ? '当前上下文还有空位，请先加入已有房间；全部满员后可以创建新房间。'
              : kook
                ? '暂无房间或已有房间全部满员，可以创建新的点灯小队。'
                : '选择一个小队加入，或创建自己的房间。'}
      </p>
      {current.length ? (
        <div className="lobby-room-grid">{current.map(card)}</div>
      ) : (
        <div className="lobby-empty">
          {lobby ? '这里还没有点灯小队，来点亮第一盏灯吧。' : '正在等待房间大厅，读取失败时可点击刷新大厅。'}
        </div>
      )}
      {kook && (
        <>
          <div className="lobby-section-heading">
            <h2>
              其他上下文房间 <small>{other.length}</small>
            </h2>
            <span className="readonly-label">仅可查看 · 从对应上下文打开后可加入</span>
          </div>
          {other.length ? (
            <div className="lobby-room-grid">{other.map(card)}</div>
          ) : (
            <div className="lobby-empty">暂时没有其他上下文的房间。</div>
          )}
        </>
      )}
    </section>
  )
}
