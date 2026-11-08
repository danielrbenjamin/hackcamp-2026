import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { readFile, mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWalkUploadQueue, type QueuedWalk, type UploadState, type WalkUploadStore } from './walkUploads.ts'
import { walkUploadHandler, databricksArchiveStore } from '../dashboard/walkUpload.ts'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function memoryStore() {
  let enabled = false
  let pending: QueuedWalk[] = []
  const store: WalkUploadStore = {
    enabled: () => enabled, setEnabled: value => { enabled = value }, list: () => pending.slice(),
    save: uri => { const item = { uri: 'persistent:' + uri, name: uri }; pending.push(item); return item },
    remove: file => { pending = pending.filter(item => item !== file) },
  }
  return store
}

test('ML uploads require opt-in; failed uploads survive restart and are retried', async () => {
  const store = memoryStore()
  let fail = true
  let state: UploadState | undefined
  const send = async () => { if (fail) throw new Error('offline') }
  const first = createWalkUploadQueue(store, send, value => { state = value })
  first.start()
  await first.enqueue('private.zip')
  assert.equal(store.list().length, 0)
  first.setEnabled(true)
  await first.enqueue('walk.zip')
  await tick()
  assert.equal(store.list().length, 1)
  assert.equal(state!.uploading, false)
  first.stop()
  fail = false
  const restarted = createWalkUploadQueue(store, send, value => { state = value })
  restarted.start()
  await tick()
  assert.equal(store.list().length, 0)
  assert.equal(state!.enabled, true)
})

test('opting out cancels an active request and retains its persistent ZIP', async () => {
  const store = memoryStore()
  const queue = createWalkUploadQueue(store, (_file, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
  }), () => {})
  queue.start()
  queue.setEnabled(true)
  await queue.enqueue('walk.zip')
  await tick()
  queue.setEnabled(false)
  await tick()
  assert.equal(store.enabled(), false)
  assert.equal(store.list().length, 1)
  await queue.enqueue('later.zip')
  assert.equal(store.list().length, 1)
})

const filename = 'lantern-walk-12345678-1234-1234-1234-123456789abc.zip'
const zip = Buffer.from([0x50, 0x4b, 3, 4, 1, 2, 3])
async function upload(handler: ReturnType<typeof walkUploadHandler>, body: Buffer,
  authorized = true) {
  // Exercise real stream/file handling without opening a network socket.
  const req = Readable.from([body]) as IncomingMessage
  req.method = 'PUT'
  req.url = `/api/ml-recordings/${filename}`
  req.headers = { authorization: authorized ? 'Bearer demo-secret' : '',
    'content-type': 'application/zip', 'content-length': String(body.length) }
  let status = 0
  let value: { stored?: boolean } = {}
  const res = { destroyed: false,
    writeHead(code: number) { status = code }, end(text: string) { value = JSON.parse(text) },
  } as unknown as ServerResponse
  await handler(req, res)
  return { status, value }
}

test('upload handler checks authentication, ZIP header and size before acknowledging storage', async () => {
  let stored = 0
  const handler = walkUploadHandler('demo-secret', async (path, digest) => {
    assert.deepEqual(await readFile(path), zip)
    assert.match(digest, /^[a-f0-9]{64}$/)
    stored++
  }, 100)
  assert.equal((await upload(handler, zip, false)).status, 401)
  assert.equal((await upload(handler, Buffer.from('not zip'))).status, 400)
  assert.equal((await upload(handler, Buffer.alloc(101))).status, 413)
  const response = await upload(handler, zip)
  assert.equal(response.status, 201)
  assert.equal(response.value.stored, true)
  assert.equal(stored, 1)
})

test('storage failures return an error rather than a successful upload receipt', async () => {
  const handler = walkUploadHandler('demo-secret', async () => { throw new Error('Databricks unavailable') })
  const response = await upload(handler, zip)
  assert.equal(response.status, 502)
  assert.notEqual(response.value.stored, true)
})

test('Databricks uploader obtains and reuses OAuth credentials and immutable file paths', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lantern-api-test-'))
  const path = join(directory, 'recording.zip')
  await writeFile(path, zip)
  t.after(async () => { await unlink(path); await rmdir(directory) })
  let authentications = 0
  let uploads = 0
  const request: typeof fetch = async (input, init) => {
    if (String(input).endsWith('/oidc/v1/token')) {
      authentications++
      assert.equal(new URLSearchParams(String(init?.body)).get('grant_type'), 'client_credentials')
      return new Response(JSON.stringify({ access_token: 'server-only-token', expires_in: 3600 }))
    }
    if (init?.method === 'HEAD') return new Response(null, { headers: { 'content-length': String(zip.length) } })
    uploads++
    assert.match(String(input), /exports\/[a-f0-9]{64}\.zip\?overwrite=false$/)
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer server-only-token')
    assert.equal((init?.headers as Record<string, string>)['Content-Length'], String(zip.length))
    for await (const _chunk of init?.body as unknown as AsyncIterable<Buffer>) { /* drain the file stream */ }
    return new Response(null, { status: uploads === 1 ? 200 : 409 })
  }
  const store = databricksArchiveStore({ host: 'https://example.cloud.databricks.com', clientId: 'client', clientSecret: 'secret' }, request)
  await store(path, 'a'.repeat(64))
  await store(path, 'a'.repeat(64))
  assert.equal(authentications, 1)
  assert.equal(uploads, 2)
})
