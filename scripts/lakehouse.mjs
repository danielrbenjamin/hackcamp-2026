import { randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Writable } from 'node:stream'
import { createInterface } from 'node:readline/promises'
import { spawn } from 'node:child_process'
import { loadEnv } from 'vite'

export const root = fileURLToPath(new URL('../', import.meta.url))
const publicKeys = ['EXPO_PUBLIC_ML_UPLOAD_URL', 'EXPO_PUBLIC_ML_UPLOAD_TOKEN']

export function httpsOrigin(value) {
  let url
  try { url = new URL(value.trim()) } catch { throw new Error('Enter a complete HTTPS origin, without /api or a notebook path.') }
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTPS origin only, without a path, username or query string.')
  }
  return url.origin
}

export function updateEnv(original, updates) {
  let text = original
  for (const [key, value] of Object.entries(updates)) {
    if (!/^[A-Z_]+$/.test(key) || /[\r\n\0]/.test(value)) throw new Error('Invalid environment setting')
    // Escape dollar signs for dotenv-expand; preserve comments and unrelated keys.
    const line = `${key}=${JSON.stringify(value).replace(/\$/g, '\\$')}`
    const pattern = new RegExp(`^${key}=.*$`, 'gm')
    if (pattern.test(text)) text = text.replace(pattern, () => line)
    else text += `${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`
  }
  return text
}

export function checkConfig(env) {
  const missing = publicKeys.filter(key => !env[key])
  if (!env.DATABRICKS_HOST) missing.push('DATABRICKS_HOST')
  if (!env.DATABRICKS_TOKEN && !(env.DATABRICKS_CLIENT_ID && env.DATABRICKS_CLIENT_SECRET)) {
    missing.push('DATABRICKS_TOKEN or both DATABRICKS_CLIENT_ID and DATABRICKS_CLIENT_SECRET')
  }
  if (missing.length) throw new Error(`Missing settings: ${missing.join(', ')}. Run npm run lakehouse:setup.`)
  httpsOrigin(env.EXPO_PUBLIC_ML_UPLOAD_URL)
  httpsOrigin(env.DATABRICKS_HOST)
  return { authentication: env.DATABRICKS_TOKEN ? 'server-side API token' : 'OAuth service principal' }
}

export function iphoneConfig(env) {
  return updateEnv('', Object.fromEntries(publicKeys.map(key => [key, env[key]])))
}

export async function saveConfig(directory, updates) {
  const path = resolve(directory, '.env.local')
  let previous = ''
  try { previous = await readFile(path, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
  await writeFile(path, updateEnv(previous, updates), { mode: 0o600 })
  // This separate handoff file has only the two public app settings, never DB credentials.
  await writeFile(resolve(directory, '.env.iphone.local'), iphoneConfig(updates), { mode: 0o600 })
}

async function setup() {
  const existing = { ...loadEnv('development', root, ''), ...process.env }
  let muted = false
  const output = new Writable({ write(chunk, _encoding, done) {
    if (!muted) process.stdout.write(chunk)
    done()
  } })
  const terminal = createInterface({ input: process.stdin, output, terminal: !!process.stdin.isTTY })
  const ask = async (label, fallback = '', secret = false) => {
    const question = terminal.question(label + (fallback && !secret ? ` [${fallback}]` : '') + ': ')
    if (secret) muted = true
    try { return (await question).trim() || fallback }
    finally { if (secret) { muted = false; process.stdout.write('\n') } }
  }
  try {
    console.log('Lantern Lakehouse setup. Keep Databricks credentials on this laptop. Press Enter to retain existing settings.')
    const host = httpsOrigin(await ask('Databricks workspace HTTPS origin', existing.DATABRICKS_HOST))
    const endpoint = httpsOrigin(await ask('HTTPS origin for this laptop (Tailscale Serve or another tunnel)', existing.EXPO_PUBLIC_ML_UPLOAD_URL))
    const method = await ask('Authentication: 1 = OAuth service principal, 2 = existing API token', existing.DATABRICKS_TOKEN ? '2' : '1')
    if (!['1', '2'].includes(method)) throw new Error('Choose authentication method 1 or 2.')
    const updates = {
      DATABRICKS_HOST: host,
      EXPO_PUBLIC_ML_UPLOAD_URL: endpoint,
      EXPO_PUBLIC_ML_UPLOAD_TOKEN: existing.EXPO_PUBLIC_ML_UPLOAD_TOKEN || randomBytes(24).toString('hex'),
      DATABRICKS_TOKEN: '', DATABRICKS_CLIENT_ID: '', DATABRICKS_CLIENT_SECRET: '',
    }
    if (method === '1') {
      updates.DATABRICKS_CLIENT_ID = await ask('Service principal client ID', existing.DATABRICKS_CLIENT_ID)
      updates.DATABRICKS_CLIENT_SECRET = await ask('OAuth secret (hidden; Enter retains existing)', existing.DATABRICKS_CLIENT_SECRET, true)
    } else {
      updates.DATABRICKS_TOKEN = await ask('Databricks API token (hidden; Enter retains existing)', existing.DATABRICKS_TOKEN, true)
    }
    checkConfig(updates)
    await saveConfig(root, updates)
    console.log('Saved .env.local on this laptop. No credentials were printed.')
    console.log('Copy ONLY the two settings in .env.iphone.local into the Mac Expo .env.local.')
    console.log('Next: npm run lakehouse:start. Keep your HTTPS proxy running.')
    console.log('This validates configuration syntax; it does not verify Databricks permissions.')
  } finally { terminal.close() }
}

async function main() {
  const command = process.argv[2] ?? 'check'
  if (command === 'setup') { await setup(); return }
  if (!['check', 'start'].includes(command)) throw new Error('Use setup, check or start.')
  const config = checkConfig({ ...loadEnv('development', root, ''), ...process.env })
  console.log(`Upload configuration present; authentication: ${config.authentication}.`)
  console.log('Databricks permissions and connectivity still require a real upload test.')
  if (command === 'start') {
    const child = spawn(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'),
      '--config', 'dashboard/vite.config.ts', '--host', '127.0.0.1', '--port', '5173', '--strictPort'],
    { cwd: root, stdio: 'inherit', env: process.env })
    child.on('error', () => { console.error('Could not start Vite. Run npm ci first.'); process.exitCode = 1 })
    child.on('exit', code => { process.exitCode = code ?? 1 })
    process.on('SIGINT', () => child.kill('SIGINT'))
    process.on('SIGTERM', () => child.kill('SIGTERM'))
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
