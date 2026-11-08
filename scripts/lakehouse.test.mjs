import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, unlink, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadEnv } from 'vite'
import { checkConfig, httpsOrigin, iphoneConfig, saveConfig, updateEnv } from './lakehouse.mjs'

const settings = {
  DATABRICKS_HOST: 'https://example.cloud.databricks.com',
  DATABRICKS_TOKEN: 'fake-server-token',
  EXPO_PUBLIC_ML_UPLOAD_URL: 'https://demo.trycloudflare.com',
  EXPO_PUBLIC_ML_UPLOAD_TOKEN: 'fake-app-token',
}

test('setup rejects HTTP, credentials in URLs and notebook/API paths', () => {
  assert.equal(httpsOrigin(settings.DATABRICKS_HOST + '/'), settings.DATABRICKS_HOST)
  for (const value of ['http://localhost:5173', 'https://example.com/api', 'https://user:pass@example.com',
    'https://example.com/?o=123', 'https://example.com/#notebook']) assert.throws(() => httpsOrigin(value))
  assert.throws(() => checkConfig({}), /Missing settings/)
})

test('check accepts supported auth modes; phone handoff excludes every server credential', () => {
  assert.equal(checkConfig(settings).authentication, 'server-side API token')
  assert.equal(checkConfig({ ...settings, DATABRICKS_TOKEN: '', DATABRICKS_CLIENT_ID: 'id',
    DATABRICKS_CLIENT_SECRET: 'secret' }).authentication, 'OAuth service principal')
  const phone = iphoneConfig(settings)
  assert.ok(phone.includes('fake-app-token'))
  assert.ok(!phone.includes('DATABRICKS'))
  assert.ok(!phone.includes('fake-server-token'))
})

test('setup preserves existing settings and writes a compatible ignored env handoff', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lantern-config-'))
  t.after(async () => {
    for (const name of ['.env.local', '.env.iphone.local']) await unlink(join(directory, name))
    await rmdir(directory)
  })
  await saveConfig(directory, settings)
  const first = await readFile(join(directory, '.env.local'), 'utf8')
  const updated = updateEnv('# Keep this\nGOOGLE_MAPS_IOS_API_KEY=maps-key\n' + first,
    { LANTERN_TEST_SECRET: 'fake$secret#value' })
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(directory, '.env.local'), updated)
  assert.ok(updated.includes('GOOGLE_MAPS_IOS_API_KEY=maps-key'))
  assert.equal(loadEnv('development', directory, '').LANTERN_TEST_SECRET, 'fake$secret#value')
  assert.equal((updated.match(/^DATABRICKS_TOKEN=/gm) ?? []).length, 1)
  assert.ok(!(await readFile(join(directory, '.env.iphone.local'), 'utf8')).includes('DATABRICKS'))
})
