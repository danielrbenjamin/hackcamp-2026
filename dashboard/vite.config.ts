import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import tailwind from '@tailwindcss/vite'
import { telemetryRelay } from './telemetry'
import { walkUploadRelay } from './walkUpload'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'EXPO_PUBLIC_')
  const backend = { ...loadEnv(mode, process.cwd(), ''), ...process.env }
  const url = env.EXPO_PUBLIC_TELEMETRY_URL
  const uploadUrl = env.EXPO_PUBLIC_ML_UPLOAD_URL
  return {
    root: fileURLToPath(new URL('.', import.meta.url)),
    server: { allowedHosts: [url, uploadUrl].filter((value): value is string => !!value).map(value => new URL(value).hostname) },
    plugins: [tailwind(), telemetryRelay(env.EXPO_PUBLIC_TELEMETRY_TOKEN), walkUploadRelay({
      token: env.EXPO_PUBLIC_ML_UPLOAD_TOKEN,
      host: backend.DATABRICKS_HOST, databricksToken: backend.DATABRICKS_TOKEN,
      clientId: backend.DATABRICKS_CLIENT_ID, clientSecret: backend.DATABRICKS_CLIENT_SECRET,
    })],
  }
})
