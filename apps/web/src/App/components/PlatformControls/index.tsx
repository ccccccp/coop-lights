import { useEffect, useState } from 'react'

import type { PlatformAdapter, PlatformContext, PlatformInspection, PlatformResource } from '@lights/contracts'

import './index.css'

interface Props {
  adapter: PlatformAdapter
  platform: PlatformContext
  busy: boolean
  run: (job: () => Promise<void>) => Promise<void>
}

const resources: { resource: PlatformResource; label: string; capability: string; scope: string }[] = [
  { resource: 'friends', label: '读取好友与私聊', capability: 'social.getFriendsAndDms', scope: 'get_user_info' },
  { resource: 'channel', label: '读取频道成员', capability: 'channel.getMembers', scope: 'get_user_info' },
  { resource: 'participants', label: '读取实例参与者', capability: 'instance.getParticipants', scope: 'get_user_info' },
  {
    resource: 'officialServer',
    label: '查询官方服务器',
    capability: 'officialServer.getStatus',
    scope: 'get_user_info',
  },
]

export function PlatformControls({ adapter, platform, busy, run }: Props) {
  const [result, setResult] = useState<{ resource: PlatformResource; value: PlatformInspection } | null>(null)
  const ready = platform.status === 'ready'
  const scopeKey = platform.authorizedScopes.join(',')
  useEffect(() => {
    setResult(null)
  }, [platform.epoch, platform.status, scopeKey])

  function inspect(resource: PlatformResource, cursor?: string) {
    return run(async () => {
      if (!adapter.inspect) throw new Error('当前模式不提供平台数据')
      setResult({ resource, value: await adapter.inspect(resource, cursor) })
    })
  }

  return (
    <div className="platform-controls">
      <div className="platform-buttons">
        {resources.map(({ resource, label, capability, scope }) => (
          <button
            className="secondary small"
            key={resource}
            type="button"
            disabled={
              busy ||
              !ready ||
              !platform.capabilities.includes(capability) ||
              !platform.authorizedScopes.includes(scope)
            }
            onClick={() => void inspect(resource)}
          >
            {label}
          </button>
        ))}
        <button
          className="secondary small"
          type="button"
          disabled={busy || !ready || !platform.capabilities.includes('ui.openOfficialServerModal')}
          onClick={() =>
            void run(async () => {
              const data = await adapter.openOfficialServer?.()
              setResult({ resource: 'officialServer', value: { data, nextCursor: null } })
            })
          }
        >
          打开官方服务器
        </button>
      </div>
      {platform.message && <p className="platform-message">{platform.message}</p>}
      {result && (
        <>
          <pre className="platform-data" data-testid="sdk-result">
            {JSON.stringify(result.value.data, null, 2)}
          </pre>
          {result.value.nextCursor && (
            <button
              className="secondary small"
              disabled={busy || !ready}
              type="button"
              onClick={() => void inspect(result.resource, result.value.nextCursor!)}
            >
              读取下一页
            </button>
          )}
        </>
      )}
      <p className="platform-note">按钮按宿主能力和已授予权限启用。广告尚未提供。</p>
    </div>
  )
}
