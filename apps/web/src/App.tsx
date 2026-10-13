import { useCallback, useEffect, useRef, useState } from 'react'
import type { GameUser, PlatformAdapter, PlatformContext, RoomSnapshot } from '@lights/contracts'
import { api, ApiError } from './api'
import { createPlatformAdapter } from './platform'
import { useConnection } from './useConnection'

const messageOf = (e: unknown) => (e instanceof Error ? e.message : '操作失败，请重试')
const prettyTime = (ms: number) =>
  `${Math.floor(Math.max(0, ms) / 60000)
    .toString()
    .padStart(2, '0')}:${Math.floor((Math.max(0, ms) / 1000) % 60)
    .toString()
    .padStart(2, '0')}`
function Mark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
    </span>
  )
}
export function App() {
  const [booted, setBooted] = useState(false),
    [user, setUser] = useState<GameUser | null>(null)
  const [room, setRoom] = useState<RoomSnapshot | null>(null),
    [nickname, setNickname] = useState('')
  const [roomCode, setRoomCode] = useState(
    () => new URL(location.href).searchParams.get('room')?.toUpperCase() ?? '',
  )
  const [platform, setPlatform] = useState<PlatformContext | null>(null)
  const [health, setHealth] = useState<Awaited<ReturnType<typeof api.health>> | null>(null)
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [seed, setSeed] = useState('')
  const [hint, setHint] = useState<number | null>(null),
    [now, setNow] = useState(Date.now())
  const adapter = useRef<PlatformAdapter | null>(null),
    actionLock = useRef(false)
  const updateRoom = useCallback(
    (next: RoomSnapshot | null) =>
      setRoom((prev) =>
        prev && next && prev.id === next.id && prev.version > next.version ? prev : next,
      ),
    [],
  )
  const refreshUser = useCallback(() => {
    void api
      .session()
      .then((s) => setUser(s.user))
      .catch(() => undefined)
  }, [])
  const connection = useConnection(user?.id, updateRoom, setNotice, refreshUser)
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const h = await api.health()
        if (!alive) return
        setHealth(h)
        adapter.current = createPlatformAdapter(h.platform.mode)
        const s = await adapter.current.initialize()
        if (!alive) return
        setUser(s.user)
        setRoom(s.room)
        setPlatform(s.platform)
      } catch (e) {
        if (alive && !(e instanceof ApiError && e.code === 'UNAUTHENTICATED'))
          setNotice(messageOf(e))
      } finally {
        if (alive) setBooted(true)
      }
    })()
    return () => {
      alive = false
      adapter.current?.dispose()
    }
  }, [])
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    setHint(null)
  }, [room?.version])
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 8000)
    return () => clearTimeout(timer)
  }, [notice])
  async function action(job: () => Promise<void>) {
    if (actionLock.current) return
    actionLock.current = true
    setBusy(true)
    setNotice('')
    try {
      await job()
    } catch (e) {
      setNotice(messageOf(e))
    } finally {
      actionLock.current = false
      setBusy(false)
    }
  }
  const connected = connection.state === '已连接',
    me = room?.players.find((p) => p.id === user?.id)
  const isHost = room?.hostId === user?.id,
    round = room?.round
  const lit = round?.board.filter(Boolean).length ?? 16
  const canStart =
    !!room &&
    room.status !== 'playing' &&
    isHost &&
    connected &&
    room.players.every((p) => !p.online || p.ready) &&
    (room.status !== 'finished' || round?.saveState === 'saved')
  const login = () =>
    action(async () => {
      if (!adapter.current?.login) throw new Error('此模式需要由 KOOK 完成登录')
      const s = await adapter.current.login(nickname)
      setUser(s.user)
      setRoom(s.room)
      setPlatform(s.platform)
    })
  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" onClick={(e) => e.preventDefault()}>
          <Mark />
          <span>
            CO-OP <b>LIGHTS</b>
          </span>
        </a>
        <div className="topbar-right">
          <span className="mode-pill">
            {health?.platform.mode === 'kook' ? 'KOOK 模式' : '独立联机'}
          </span>
          {user && (
            <>
              <span className="user-name">{user.nickname}</span>
              <button
                className="text-button"
                onClick={() =>
                  void action(async () => {
                    await api.logout()
                    setUser(null)
                    setRoom(null)
                    setPlatform(null)
                  })
                }
              >
                退出登录
              </button>
            </>
          )}
        </div>
      </header>
      <main>
        {notice && (
          <div className="notice" role="status">
            <span>{notice}</span>
            <button className="text-button" aria-label="关闭提示" onClick={() => setNotice('')}>
              ×
            </button>
          </div>
        )}
        {!booted ? (
          <div className="loading">正在连接点灯世界…</div>
        ) : !user ? (
          <section className="welcome">
            <div className="welcome-copy">
              <p className="eyebrow">SMALL PUZZLE. SHARED MOMENT.</p>
              <h1>
                一起，
                <br />
                把灯点亮<span>。</span>
              </h1>
              <p className="intro">
                一块灯阵，几位伙伴。
                <br />
                每次点击都会改变相邻的灯，
                <br />
                一起找到让所有灯亮起的方法。
              </p>
              <div className="feature-row">
                <span>1—4 位玩家</span>
                <span>实时协作</span>
                <span>随时加入</span>
              </div>
              <div className="welcome-grid" aria-hidden="true">
                {Array.from({ length: 16 }, (_, i) => (
                  <i className={[0, 1, 4, 7, 8, 10, 13, 15].includes(i) ? 'lit' : ''} key={i} />
                ))}
              </div>
            </div>
            <form
              className="entry-card"
              onSubmit={(e) => {
                e.preventDefault()
                void login()
              }}
            >
              <span className="small-mark">✦</span>
              <h2>准备好一起解谜了吗？</h2>
              <p>取一个昵称，先进入大厅。</p>
              <label htmlFor="nickname">你的昵称</label>
              <input
                id="nickname"
                data-testid="nickname"
                maxLength={20}
                value={nickname}
                autoComplete="off"
                placeholder="比如：点灯小队长"
                onChange={(e) => setNickname(e.target.value)}
                autoFocus
              />
              <button
                className="primary wide"
                disabled={busy || !nickname.trim() || health?.platform.mode === 'kook'}
              >
                {busy ? '正在进入…' : '进入游戏 →'}
              </button>
              <p className="entry-note">
                邀请朋友加入同一房间，
                <br />
                也可以一个人先试试。
              </p>
            </form>
          </section>
        ) : !room ? (
          <section className="lobby">
            <div className="section-heading">
              <p className="eyebrow">THE NEXT LIGHT IS YOURS</p>
              <h1>
                你好，{user.nickname}
                <span>。</span>
              </h1>
              <p>新建一间房，或加入朋友的点灯小队。</p>
            </div>
            <div className="lobby-grid">
              <article className="lobby-card">
                <span className="card-number">01 / CREATE</span>
                <h2>组建点灯小队</h2>
                <p>
                  从一盏灯开始，最多四人共同解谜。
                  <br />
                  房间创建后就可以邀请朋友。
                </p>
                <button
                  className="primary"
                  data-testid="create-room"
                  disabled={busy || !connected}
                  onClick={() =>
                    void action(async () => {
                      const r = await api.create()
                      updateRoom(r.room)
                    })
                  }
                >
                  创建房间 <span>＋</span>
                </button>
              </article>
              <form
                className="lobby-card"
                onSubmit={(e) => {
                  e.preventDefault()
                  void action(async () => {
                    const r = await api.join(roomCode.trim().toUpperCase())
                    updateRoom(r.room)
                  })
                }}
              >
                <span className="card-number">02 / JOIN</span>
                <h2>加入朋友的房间</h2>
                <p>
                  输入朋友分享的 6 位房间号。
                  <br />
                  游戏开始后也可以加入。
                </p>
                <label className="sr-only" htmlFor="room-code">
                  房间号
                </label>
                <div className="join-row">
                  <input
                    id="room-code"
                    data-testid="room-code"
                    value={roomCode}
                    maxLength={6}
                    placeholder="ABC234"
                    onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
                  />
                  <button
                    className="secondary"
                    disabled={busy || !connected || roomCode.length !== 6}
                  >
                    加入 →
                  </button>
                </div>
              </form>
            </div>
            <div className="lobby-footer">
              <span>
                <b>{user.completedRounds}</b> 次累计通关
              </span>
              <span>用另一浏览器或无痕窗口，以第二位玩家加入。</span>
            </div>
          </section>
        ) : (
          <section className="game-view">
            <div className="game-heading">
              <div>
                <p className="eyebrow">LIGHT IT UP, TOGETHER</p>
                <h1>{room.status === 'finished' ? '每一盏，都亮了。' : '一盏接着一盏。'}</h1>
              </div>
              <div className="room-tools">
                <span className="room-code">
                  房间 <b data-testid="active-room-code">{room.id}</b>
                </span>
                <button
                  className="secondary small"
                  onClick={() =>
                    void action(async () => {
                      const result = await adapter.current!.invite(room.id)
                      if (result.status === 'submitted')
                        setNotice(result.url ? '邀请链接已复制，发给朋友即可加入' : '邀请已提交')
                    })
                  }
                >
                  复制邀请
                </button>
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      await api.leave(room.id)
                      setRoom(null)
                      refreshUser()
                    })
                  }
                >
                  离开房间
                </button>
              </div>
            </div>
            <div className="play-layout">
              <article className="board-panel">
                <div className="board-meta">
                  <span>{round ? `第 ${round.number} 关` : '等待小队集合'}</span>
                  <span>
                    {lit}
                    <small> / 16 盏已亮</small>
                  </span>
                </div>
                <div className="progress">
                  <i style={{ width: `${(lit / 16) * 100}%` }} />
                </div>
                <div
                  className={`board ${room.status !== 'playing' ? 'inactive' : ''}`}
                  data-testid="board"
                >
                  {(round?.board ?? Array<boolean>(16).fill(true)).map((on, i) => (
                    <button
                      key={i}
                      type="button"
                      aria-label={`第 ${Math.floor(i / 4) + 1} 行第 ${(i % 4) + 1} 列，${on ? '亮' : '灭'}`}
                      aria-pressed={on}
                      data-testid={`cell-${i}`}
                      className={`cell ${on ? 'on' : 'off'} ${hint === i ? 'hinted' : ''}`}
                      disabled={busy || !connected || room.status !== 'playing'}
                      onClick={() =>
                        void action(() =>
                          connection.command({
                            type: 'board.toggle',
                            roomId: room.id,
                            roundId: round!.id,
                            expectedVersion: room.version,
                            cell: i,
                          }),
                        )
                      }
                    >
                      <span className="light-core" />
                      <span className="cell-label">{(i + 1).toString().padStart(2, '0')}</span>
                    </button>
                  ))}
                </div>
                <div className="board-caption">
                  <span>点击一盏灯，会切换它与上下左右相邻的灯。</span>
                  {room.lastMove && (
                    <span>
                      {room.lastMove.nickname} 刚刚点击了 {room.lastMove.cell + 1} 号灯
                    </span>
                  )}
                </div>
                {room.status === 'finished' && (
                  <div className="finish-banner" data-testid="finished">
                    <span>✦</span>
                    <div>
                      <strong>协作成功！</strong>
                      <p>
                        用时 {prettyTime(round!.finishedAt! - round!.startedAt)} · 共 {round!.moves}{' '}
                        次操作
                      </p>
                    </div>
                    <span className="save-label">
                      {round?.saveState === 'saved'
                        ? '记录已保存'
                        : round?.saveState === 'failed'
                          ? '保存失败'
                          : '保存中…'}
                    </span>
                  </div>
                )}
                <div className="round-controls">
                  <button
                    className="secondary"
                    disabled={busy || !connected || room.status === 'playing'}
                    onClick={() =>
                      void action(() =>
                        connection.command({
                          type: 'room.ready',
                          roomId: room.id,
                          ready: !me?.ready,
                        }),
                      )
                    }
                  >
                    {me?.ready ? '取消准备' : '我准备好了'}
                  </button>
                  {isHost && (
                    <button
                      className="primary"
                      data-testid="start-round"
                      disabled={busy || !canStart}
                      onClick={() =>
                        void action(() =>
                          connection.command({
                            type: 'round.start',
                            roomId: room.id,
                            ...(seed.trim() && health?.devTools ? { seed: Number(seed) } : {}),
                          }),
                        )
                      }
                    >
                      {room.status === 'finished' ? '开始下一关 →' : '开始点灯 →'}
                    </button>
                  )}
                  {round?.saveState === 'failed' && (
                    <button
                      className="secondary"
                      onClick={() =>
                        void action(() =>
                          connection.command({
                            type: 'round.retrySave',
                            roomId: room.id,
                          }),
                        )
                      }
                    >
                      重试保存
                    </button>
                  )}
                </div>
              </article>
              <aside className="team-panel">
                <div className="team-title">
                  <h2>点灯小队</h2>
                  <span>
                    {room.players.length} / {room.maxPlayers}
                  </span>
                </div>
                <div className="players">
                  {room.players.map((p, index) => (
                    <div className="player" key={p.id}>
                      <span className={`avatar avatar-${index}`}>
                        <span>{p.nickname.slice(0, 1)}</span>
                        <i className={p.online ? 'online' : ''} />
                      </span>
                      <div className="player-info">
                        <strong>
                          {p.nickname}
                          {p.id === user.id && <small>（你）</small>}
                        </strong>
                        <span>
                          {p.online
                            ? room.status === 'playing'
                              ? `${p.contribution} 次贡献`
                              : p.ready
                                ? '已准备'
                                : '等待准备'
                            : `等待重连 · ${Math.max(0, Math.ceil(((p.reconnectUntil ?? now) - now) / 1000))} 秒`}
                        </span>
                      </div>
                      {p.id === room.hostId && <span className="host-tag">房主</span>}
                    </div>
                  ))}
                  {Array.from({ length: room.maxPlayers - room.players.length }, (_, i) => (
                    <div className="empty-player" key={i}>
                      <span>＋</span>等待另一位伙伴
                    </div>
                  ))}
                </div>
                <div className="session-stats">
                  <div>
                    <span>本局用时</span>
                    <strong>
                      {round ? prettyTime((round.finishedAt ?? now) - round.startedAt) : '00:00'}
                    </strong>
                  </div>
                  <div>
                    <span>操作次数</span>
                    <strong>{round?.moves ?? 0}</strong>
                  </div>
                </div>
                <p className="team-tip">
                  所有在线成员准备后，房主即可开始。
                  <br />
                  中途加入不影响正在进行的关卡。
                </p>
              </aside>
            </div>
          </section>
        )}
        {user && (
          <div className="connection-line">
            <span className={`status-dot ${connected ? 'online' : ''}`} />
            <span>{connection.state}</span>
            {!connected && (
              <button className="text-button" onClick={connection.reconnect}>
                重新连接
              </button>
            )}
            <span className="connection-meta">{user.completedRounds} 次累计通关</span>
          </div>
        )}
        {user && (
          <details className="test-panel">
            <summary>
              开发与平台测试面板 <span>SDK 适配入口已预留</span>
            </summary>
            <div className="test-grid">
              <dl>
                <dt>运行模式</dt>
                <dd>{platform?.mode ?? 'standalone'}（真实 KOOK SDK 未接入）</dd>
                <dt>存储</dt>
                <dd>{health?.storage}</dd>
                <dt>平台实例</dt>
                <dd>{room?.platformInstanceId ?? '无；本地房间不等于 KOOK 实例'}</dd>
                <dt>房间 / 版本</dt>
                <dd>
                  {room?.id ?? '—'} / {room?.version ?? '—'}
                </dd>
                <dt>平台能力</dt>
                <dd>{platform?.capabilities.join(', ') || '无'}</dd>
              </dl>
              <div className="test-actions">
                {health?.devTools && (
                  <>
                    <label htmlFor="seed">下一关固定种子（可选）</label>
                    <input
                      id="seed"
                      inputMode="numeric"
                      value={seed}
                      onChange={(e) => setSeed(e.target.value.replace(/\D/g, '').slice(0, 10))}
                      placeholder="例如 42"
                    />
                    <div>
                      <button className="secondary small" onClick={connection.disconnect}>
                        断线重连测试
                      </button>
                      <button
                        className="secondary small"
                        disabled={!room || room.status !== 'playing' || busy}
                        onClick={() =>
                          void action(async () => {
                            const r = await api.hint(room!.id)
                            setHint(r.cells[0] ?? null)
                            setNotice(
                              r.cells.length
                                ? `建议点击 ${r.cells[0] + 1} 号灯，黄色边框已标记`
                                : '棋盘已完成',
                            )
                          })
                        }
                      >
                        下一步提示
                      </button>
                      <button
                        className="secondary small"
                        disabled={!room || !connected || busy}
                        onClick={() =>
                          void action(() =>
                            connection.command({
                              type: 'room.snapshot',
                              roomId: room!.id,
                            }),
                          )
                        }
                      >
                        刷新快照
                      </button>
                    </div>
                  </>
                )}
                <p>好友、频道成员、官方服务器与广告：等待真实 SDK 提供能力，不模拟成功。</p>
              </div>
            </div>
          </details>
        )}
      </main>
      <footer className="footer">
        <span>CO-OP LIGHTS / 一起点亮，小小世界</span>
        <span>React + Node.js · 联机测试游戏</span>
      </footer>
    </div>
  )
}
