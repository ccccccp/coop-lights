import { useEffect, useRef, useState } from 'react'

import type { GameUser, LeaderboardResponse } from '@lights/contracts'

import { api } from '../../../api'
import { UserAvatar } from '../UserAvatar'

import './index.css'

export function Leaderboard({ user, onClose }: { user: GameUser; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [result, setResult] = useState<LeaderboardResponse | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    const element = dialog.current!
    element.showModal()
    return () => element.close()
  }, [])
  useEffect(() => {
    let alive = true
    setLoading(true)
    setError('')
    void api
      .leaderboard()
      .then((value) => {
        if (alive) setResult(value)
      })
      .catch((reason: unknown) => {
        if (alive) setError(reason instanceof Error ? reason.message : '排行榜暂时无法加载，请重试')
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [user.id, user.completedRounds, refresh])
  return (
    <dialog
      ref={dialog}
      className="leaderboard-dialog"
      aria-labelledby="leaderboard-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="leaderboard-content">
        <div className="leaderboard-heading">
          <div>
            <p className="eyebrow">LIGHTS OF HONOR</p>
            <h2 id="leaderboard-title">通关次数排行榜</h2>
          </div>
          <button className="text-button leaderboard-close" aria-label="关闭排行榜" onClick={onClose} autoFocus>
            ×
          </button>
        </div>
        <p className="leaderboard-description">累计通关玩家前 100 位 · 通关次数相同则并列</p>
        <div className="leaderboard-body" aria-busy={loading}>
          {error ? (
            <div className="leaderboard-message" role="alert">
              {error}
              <button className="secondary small" onClick={() => setRefresh((value) => value + 1)}>
                重试
              </button>
            </div>
          ) : !result ? (
            <p className="leaderboard-message" role="status">
              正在加载排行榜…
            </p>
          ) : result.items.length === 0 ? (
            <p className="leaderboard-message">还没有通关记录，快和伙伴点亮第一关吧。</p>
          ) : (
            <>
              <div className="leaderboard-columns" aria-hidden="true">
                <span>名次</span>
                <span>KOOK 玩家</span>
                <span>通关次数</span>
              </div>
              <ol className="leaderboard-list" aria-label="通关排名">
                {result.items.map((entry) => (
                  <li
                    key={entry.id}
                    value={entry.rank}
                    className={`leaderboard-entry ${entry.id === user.id ? 'is-me' : ''}`}
                  >
                    <span className={`leaderboard-rank ${entry.rank <= 3 ? 'top-rank' : ''}`}>{entry.rank}</span>
                    <div className="leaderboard-player">
                      <UserAvatar nickname={entry.nickname} avatarUrl={entry.avatarUrl} />
                      <span className="leaderboard-name" title={entry.nickname}>
                        {entry.nickname}
                        {entry.id === user.id && <small>（你）</small>}
                      </span>
                    </div>
                    <span className="leaderboard-score">
                      {entry.completedRounds}
                      <small> 次</small>
                    </span>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
        <div className="leaderboard-footer">
          <span>
            {loading
              ? '正在更新…'
              : result && !error
                ? `更新于 ${new Date(result.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })}`
                : '请稍后重试'}
          </span>
          <button className="secondary small" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>
            刷新排行榜
          </button>
        </div>
      </div>
    </dialog>
  )
}
