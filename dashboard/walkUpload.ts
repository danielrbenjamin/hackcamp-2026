import { createHash, timingSafeEqual } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, rm, rmdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline, finished } from 'node:stream/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'

export interface WalkUploadConfig {
  token?: string
  host?: string
  databricksToken?: string
  clientId?: string
  clientSecret?: string
}

// Files API credentials are resolved only on the server, never Expo's public env.
export function databricksArchiveStore(config: WalkUploadConfig, request: typeof fetch = fetch) {
  let cached: { value: string; expires: number } | undefined
  async function credential() {
    if (config.databricksToken) return config.databricksToken
    if (cached && Date.now() < cached.expires) return cached.value
    if (!config.clientId || !config.clientSecret) throw new Error('Databricks authentication is missing')
    const response = await request(`${host()}/oidc/v1/token`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'all-apis' }),
    })
    if (!response.ok) throw new Error('Databricks authentication failed')
    const value = await response.json() as { access_token?: string; expires_in?: number }
    if (!value.access_token || !Number.isFinite(value.expires_in)) throw new Error('Invalid authentication response')
    cached = { value: value.access_token, expires: Date.now() + Math.max(0, value.expires_in! - 60) * 1000 }
    return cached.value
  }
  function host() {
    const url = new URL(config.host ?? '')
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('Invalid Databricks host')
    }
    return url.origin
  }
  return async (path: string, digest: string) => {
    const token = await credential()
    const url = `${host()}/api/2.0/fs/files/Volumes/workspace/default/lantern_walks/exports/${digest}.zip`
    const size = (await stat(path)).size
    const stream = createReadStream(path)
    try {
      const response = await request(`${url}?overwrite=false`, {
        method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(120_000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) },
        body: stream as unknown as BodyInit, duplex: 'half',
      } as RequestInit)
      await response.body?.cancel()
      if (response.status === 409) {
        // Confirm the immutable object actually exists before acknowledging a
        // retry. An unrelated conflict must not delete the phone's queued ZIP.
        const existing = await request(url, { method: 'HEAD', redirect: 'error',
          headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) })
        if (!existing.ok || existing.headers.get('content-length') !== String(size)) {
          throw new Error('Existing archive could not be verified')
        }
      } else if (!response.ok) throw new Error(`Databricks storage failed (${response.status})`)
    } finally { stream.destroy(); await finished(stream).catch(() => {}) }
  }
}

export function walkUploadHandler(token: string | undefined,
  store: (path: string, digest: string) => Promise<void>, maxBytes = 1_000_000_000) {
  let busy = false
  return async (req: IncomingMessage, res: ServerResponse) => {
    const reply = (code: number, value: object) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(value))
    }
    const expected = Buffer.from(`Bearer ${token ?? ''}`)
    const supplied = Buffer.from(req.headers.authorization ?? '')
    if (!token || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      reply(401, { error: 'Upload authentication required' }); return
    }
    if (req.method !== 'PUT') { reply(405, { error: 'Use PUT' }); return }
    if (!/^\/api\/ml-recordings\/lantern-walk-[a-f0-9-]{36}\.zip$/i.test(req.url ?? '')) {
      reply(400, { error: 'Invalid recording filename' }); return
    }
    if (req.headers['content-type'] !== 'application/zip') { reply(415, { error: 'Expected application/zip' }); return }
    if (Number(req.headers['content-length']) > maxBytes) { reply(413, { error: 'Recording too large' }); return }
    if (busy) { reply(429, { error: 'Another recording is uploading; retry later' }); return }
    busy = true
    let directory: string | undefined
    try {
      directory = await mkdtemp(join(tmpdir(), 'lantern-upload-'))
      const path = join(directory, 'recording.zip')
      const hash = createHash('sha256')
      let bytes = 0
      let signature = Buffer.alloc(0)
      const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length
        if (bytes > maxBytes) { callback(new Error('Recording too large')); return }
        if (signature.length < 4) signature = Buffer.concat([signature, chunk.subarray(0, 4 - signature.length)])
        hash.update(chunk)
        callback(null, chunk)
      } })
      // Do not buffer a camera recording in RAM. Keep req out of pipeline so an
      // upstream error can still return an HTTP response to the phone.
      req.on('error', error => meter.destroy(error))
      req.on('aborted', () => meter.destroy(new Error('Upload aborted')))
      req.pipe(meter)
      await pipeline(meter, createWriteStream(path))
      if (!signature.equals(Buffer.from([0x50, 0x4b, 3, 4]))) { reply(400, { error: 'Invalid ZIP header' }); return }
      const digest = hash.digest('hex')
      await store(path, digest)
      reply(201, { stored: true, sha256: digest })
    } catch (error) {
      if (!res.destroyed) reply(error instanceof Error && error.message === 'Recording too large' ? 413 : 502,
        { error: 'Upload not stored. Keep the local recording and retry.' })
    } finally {
      // These are exact files/directories created above, never client-supplied paths.
      if (directory) {
        await rm(join(directory, 'recording.zip'), { force: true }).catch(() => {})
        await rmdir(directory).catch(() => {})
      }
      busy = false
    }
  }
}

export function walkUploadRelay(config: WalkUploadConfig): Plugin {
  const handle = walkUploadHandler(config.token, databricksArchiveStore(config))
  return { name: 'lantern-walk-upload', configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (!request.url?.startsWith('/api/ml-recordings/')) { next(); return }
      void handle(request, response)
    })
  } }
}
