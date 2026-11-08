export interface QueuedWalk { name: string; uri: string }
export interface UploadState { enabled: boolean; pending: number; uploading: boolean; message: string }
export interface WalkUploadStore {
  enabled(): boolean
  setEnabled(value: boolean): void
  list(): QueuedWalk[]
  save(uri: string): QueuedWalk | Promise<QueuedWalk>
  remove(file: QueuedWalk): void
}

// Queue files and consent live in persistent storage; the network is independent
// of navigation. Only recordings saved while opted in enter the upload queue.
export function createWalkUploadQueue(store: WalkUploadStore,
  send: (file: QueuedWalk, signal: AbortSignal) => Promise<void>,
  report: (state: UploadState) => void) {
  let enabled = false
  let active: AbortController | undefined
  let message = ''
  const status = () => {
    try { report({ enabled, pending: store.list().length, uploading: !!active, message }) }
    catch { report({ enabled, pending: 0, uploading: !!active, message: 'Could not read saved ML uploads.' }) }
  }
  async function retry() {
    if (!enabled || active) return
    const controller = new AbortController()
    active = controller
    try {
      for (const file of store.list()) {
        if (!enabled || controller.signal.aborted) break
        message = 'Uploading ML recording.'
        status()
        await send(file, controller.signal)
        // Delete ONLY after an explicit successful storage receipt.
        store.remove(file)
        message = 'ML recording uploaded to Databricks.'
      }
    } catch {
      message = enabled ? 'Upload pending. Saved on this iPhone for retry.' : 'Automatic uploads paused.'
    } finally {
      active = undefined
      status()
    }
  }
  return {
    start() { enabled = store.enabled(); status(); void retry() },
    setEnabled(value: boolean) {
      store.setEnabled(value)
      enabled = value
      if (!value) { active?.abort(); message = 'Automatic uploads paused.' }
      status()
      if (value) void retry()
    },
    async enqueue(uri: string) {
      if (!enabled) return
      await store.save(uri) // Persist before Stop finishes and a new recording can delete the temporary ZIP.
      message = 'ML recording saved for upload.'
      status()
      void retry()
    },
    retry,
    stop() { enabled = false; active?.abort() },
  }
}
