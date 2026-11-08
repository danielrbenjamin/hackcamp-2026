import { Directory, File, Paths } from 'expo-file-system'
import { copyAsync } from 'expo-file-system/legacy'
import { fetch } from 'expo/fetch'
import { createWalkUploadQueue, type UploadState } from '../shared/walkUploads'

export function walkUploads(endpoint: string | undefined, token: string | undefined,
  report: (state: UploadState) => void) {
  // Lazy filesystem access keeps the browser simulator usable.
  const prepare = () => {
    const directory = new Directory(Paths.document, 'lantern-ml-uploads')
    directory.create({ intermediates: true, idempotent: true })
    return { directory, settings: new File(directory, 'settings.json') }
  }
  return createWalkUploadQueue({
    enabled() {
      const { settings } = prepare()
      try { return settings.exists && JSON.parse(settings.textSync()).enabled === true }
      catch { return false }
    },
    setEnabled(enabled) {
      const { settings } = prepare()
      if (!settings.exists) settings.create()
      settings.write(JSON.stringify({ enabled }))
    },
    list() {
      const { directory } = prepare()
      return directory.list().filter((file): file is File => file instanceof File && file.name.endsWith('.zip'))
        .map(file => ({ name: file.name, uri: file.uri }))
    },
    async save(uri) {
      const { directory } = prepare()
      const source = new File(uri)
      if (!/^lantern-walk-[a-f0-9-]{36}\.zip$/i.test(source.name)) throw new Error('Invalid ML recording filename')
      const file = new File(directory, source.name)
      if (!file.exists) {
        const temporary = new File(directory, source.name + '.partial')
        if (temporary.exists) temporary.delete()
        // A large RGB recording must not block the JS guidance loop while copying.
        await copyAsync({ from: source.uri, to: temporary.uri })
        temporary.move(file)
      }
      return { name: file.name, uri: file.uri }
    },
    remove(file) { new File(file.uri).delete() },
  }, async (file, signal) => {
    if (!endpoint || !token) throw new Error('ML upload is not configured')
    const url = new URL(endpoint)
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.username || url.password || url.search || url.hash) {
      throw new Error('An HTTPS upload server is required')
    }
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    const timer = setTimeout(abort, 300_000)
    try {
      const response = await fetch(`${endpoint.replace(/\/$/, '')}/api/ml-recordings/${encodeURIComponent(file.name)}`, {
        method: 'PUT', body: new File(file.uri),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/zip' }, signal: controller.signal,
      })
      if (!response.ok || (await response.json()).stored !== true) throw new Error('Upload was not acknowledged')
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort) }
  }, report)
}
