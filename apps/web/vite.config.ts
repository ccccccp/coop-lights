import { defineConfig, loadEnv } from 'vite'

import react from '@vitejs/plugin-react'

import { browserTargets } from '../../../kook-minigame-sdk/scripts/browser-targets.mjs'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', '')
  const target = `http://127.0.0.1:${env.SERVER_PORT || '5188'}`
  return {
    envDir: '../..',
    plugins: [react()],
    build: { target: [...browserTargets] },
    server: {
      port: Number(env.WEB_PORT || 5178),
      strictPort: true,
      proxy: { '/api': target, '/ws': { target, ws: true } },
    },
  }
})
