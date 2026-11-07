import { File, Paths } from 'expo-file-system'
import { isAvailableAsync, shareAsync } from 'expo-sharing'
import { Platform } from 'react-native'
import type { Telemetry } from '../shared/contracts'

export function telemetrySummary(frame: Telemetry, sharePoints = false): Telemetry {
  const { depth: _depth, pose: _pose, forwardTrueHeading: _heading, points, ...observation } = frame.observation
  const { trueBearing: _bearing, updatedAtMs: _updated, ...route } = frame.route
  return { ...frame, observation: sharePoints && points ? { ...observation, points } : observation,
    route: { ...route, destination: '', maneuver: '' } }
}

export function createRecording() {
  const startedAtMs = Date.now()
  const sessionId = `${startedAtMs}-${Math.random().toString(36).slice(2, 10)}`
  const lines: string[] = []
  return {
    append(frame: Telemetry) {
      if (lines.length >= 240) return
      const { route } = telemetrySummary(frame)
      const { points: _points, ...observation } = frame.observation
      lines.push(JSON.stringify({ schemaVersion: 1, sessionId, sequence: lines.length, startedAtMs,
        consent: { granted: true, scope: 'local-recording' }, frame: { ...frame, observation, route } }))
    },
    count: () => lines.length,
    async share() {
      if (!lines.length) throw new Error('The recording has no frames.')
      const filename = `navigation-${sessionId}.ndjson`
      const data = `${lines.join('\n')}\n`
      if (Platform.OS === 'web') {
        const url = URL.createObjectURL(new Blob([data], { type: 'application/x-ndjson' }))
        const link = document.createElement('a')
        link.href = url
        link.download = filename
        link.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
        return
      }
      if (!await isAvailableAsync()) throw new Error('Sharing is unavailable on this device.')
      const file = new File(Paths.cache, filename)
      file.create({ overwrite: true })
      try {
        file.write(data)
        await shareAsync(file.uri, { mimeType: 'application/x-ndjson', UTI: 'public.plain-text' })
      } finally {
        file.delete()
      }
    },
  }
}
