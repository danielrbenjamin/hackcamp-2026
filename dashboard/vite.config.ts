import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import tailwind from '@tailwindcss/vite'
import { telemetryRelay } from './telemetry'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'EXPO_PUBLIC_')
  const url = env.EXPO_PUBLIC_TELEMETRY_URL
  return {
    root: fileURLToPath(new URL('.', import.meta.url)),
    server: { allowedHosts: url ? [new URL(url).hostname] : [] },
    plugins: [tailwind(), telemetryRelay(env.EXPO_PUBLIC_TELEMETRY_TOKEN)],
  }
})
