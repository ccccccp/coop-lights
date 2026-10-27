import { useState } from 'react'

import './index.css'

export function UserAvatar({
  nickname,
  avatarUrl,
  online,
  className = '',
}: {
  nickname: string
  avatarUrl?: string | null
  online?: boolean
  className?: string
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  return (
    <span className={`avatar user-avatar ${className}`}>
      {avatarUrl && failedUrl !== avatarUrl ? (
        <img
          src={avatarUrl}
          alt={`${nickname}的 KOOK 头像`}
          referrerPolicy="no-referrer"
          onError={() => setFailedUrl(avatarUrl)}
        />
      ) : (
        <span aria-label={`${nickname}的头像`}>{Array.from(nickname)[0] ?? '?'}</span>
      )}
      {online !== undefined && <i className={online ? 'online' : ''} />}
    </span>
  )
}
