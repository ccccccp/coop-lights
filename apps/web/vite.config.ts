import { Agent } from 'node:https'
import { fileURLToPath } from 'node:url'

import { defineConfig, loadEnv } from 'vite'

import react from '@vitejs/plugin-react'

import { browserTargets } from '../../../kook-minigame-sdk/scripts/browser-targets.mjs'
import { readGameTls } from '../../scripts/tls'

export default defineConfig(({ mode, command }) => {
  const projectRoot = fileURLToPath(new URL('../..', import.meta.url))
  const env = loadEnv(mode, projectRoot, '')
  const serverHttps = env.SERVER_HTTPS === 'true'
  const target = `${serverHttps ? 'https' : 'http'}://127.0.0.1:${env.SERVER_PORT || '5188'}`
  const backendTls =
    command === 'serve' ? readGameTls(serverHttps, env.GAME_TLS_CERT, env.GAME_TLS_KEY, projectRoot) : undefined
  const proxy = { target, ...(backendTls ? { agent: new Agent({ ca: backendTls.cert }) } : {}) }
  return {
    envDir: projectRoot,
    plugins: [react()],
    build: { target: [...browserTargets] },
    server: {
      port: Number(env.WEB_PORT || 5178),
      strictPort: true,
      https:
        command === 'serve'
          ? readGameTls(env.WEB_HTTPS === 'true', env.GAME_TLS_CERT, env.GAME_TLS_KEY, projectRoot)
          : undefined,
      // HTTPS 上游只信任配置的开发证书，保持证书及主机名校验。
      proxy: { '/api': proxy, '/ws': { ...proxy, ws: true } },
    },
  }
})
