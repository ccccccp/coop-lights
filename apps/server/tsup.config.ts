import { defineConfig } from 'tsup'
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'es2022',
  noExternal: ['@lights/contracts'],
  outDir: 'dist',
  clean: true,
})
