import type { Plugin } from 'vite'
import { MAX_DEPTH_POINTS, MAX_DEPTH_PREVIEW_DIMENSION, type DepthPreview } from '../shared/contracts'
import { validHazards } from '../shared/hazards'
function validPreview(preview: unknown) {
  if (preview === undefined) return true
  if (!preview || typeof preview !== 'object') return false
  const { width, height, samples } = preview as DepthPreview
  const bytes = width * height * 2
  return [width, height].every(size => Number.isInteger(size) && size > 0 && size <= MAX_DEPTH_PREVIEW_DIMENSION) &&
    typeof samples === 'string' && samples.length === 4 * Math.ceil(bytes / 3) &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(samples) && Buffer.from(samples, 'base64').length === bytes
}

function validModelPreview(preview: unknown) {
  if (preview === undefined) return true
  if (!preview || typeof preview !== 'object') return false
  const { timeMs, latencyMs, models, masks, people, depthPreview } = preview as import('../shared/contracts').ModelPreview
  const point = (value: unknown) => Array.isArray(value) && value.length === 3 &&
    value.every(n => Number.isFinite(n) && Math.abs(n) <= 10)
  return validPreview(depthPreview) && Number.isFinite(timeMs) && Number.isFinite(latencyMs) && latencyMs >= 0 &&
    !!models && ['glass', 'stairs', 'person'].every(kind => typeof models[kind as keyof typeof models] === 'string' &&
      models[kind as keyof typeof models].length <= 180) &&
    Array.isArray(masks) && masks.length <= 2 && masks.every(mask => mask && ['glass', 'stairs'].includes(mask.kind) &&
      mask.size === 96 && typeof mask.labels === 'string' && mask.labels.length === 12_288 &&
      /^[A-Za-z0-9+/]+$/.test(mask.labels) && Array.isArray(mask.points) &&
      mask.points.length <= 576 && mask.points.every(point)) &&
    Array.isArray(people) && people.length <= 16 && people.every(person => person &&
      Array.isArray(person.box) && person.box.length === 4 &&
      person.box.every(n => Number.isFinite(n) && n >= 0 && n <= 1) &&
      Number.isFinite(person.confidence) && person.confidence >= 0 && person.confidence <= 1 &&
      (person.position === undefined || point(person.position)) &&
      (person.predictedPosition === undefined || point(person.predictedPosition)))
}

export function telemetryRelay(token: string | undefined): Plugin {
  let latest: { receivedAt: number; frame: unknown } | null = null
  return {
    name: 'navigation-telemetry',
    configureServer(server) {
      server.middlewares.use('/api/telemetry', (request, response) => {
        response.setHeader('Cache-Control', 'no-store')
        if (!token || request.headers.authorization !== `Bearer ${token}`) {
          response.writeHead(401).end()
          return
        }
        if (request.method === 'GET') {
          response.setHeader('Content-Type', 'application/json')
          response.end(JSON.stringify(latest))
          return
        }
        if (request.method !== 'POST') {
          response.writeHead(405).end()
          return
        }
        let body = ''
        request.setEncoding('utf8')
        request.on('data', chunk => {
          body += chunk
          if (body.length > 840_000) request.destroy()
        })
        request.on('end', () => {
          try {
            const frame = JSON.parse(body)
            const observation = frame?.observation
            const grid = observation?.grid
            const points = observation?.points
            const colors = observation?.pointColors
            const validPoints = points === undefined || (Array.isArray(points) && points.length <= MAX_DEPTH_POINTS &&
              points.every(point => Array.isArray(point) && point.length === 3 && point.every(Number.isFinite)))
            const validColors = colors === undefined || (Array.isArray(points) && points.length > 0 &&
              typeof colors === 'string' && colors.length === points.length * 4 && /^[A-Za-z0-9+/]+$/.test(colors))
            if (frame?.schemaVersion !== 1 || !Number.isFinite(observation?.timeMs) ||
              !Array.isArray(observation?.zones) || observation.zones.length !== 5 ||
              grid?.width !== 40 || grid.height !== 20 || !Array.isArray(grid.cells) || grid.cells.length !== 800 ||
              observation.depth !== undefined || observation.pose !== undefined || !validPoints || !validColors ||
              !validPreview(observation.depthPreview) || !validPreview(observation.smoothedDepthPreview) ||
              !validModelPreview(frame.modelPreview) ||
              (observation.hazards !== undefined && !validHazards(observation.hazards)) ||
              !Array.isArray(frame.command?.motors) || frame.command.motors.length !== 5 || !frame.route || !frame.belt) {
              response.writeHead(400).end()
              return
            }
            delete observation.scanPose
            latest = { receivedAt: Date.now(), frame }
            response.writeHead(204).end()
          } catch {
            response.writeHead(400).end()
          }
        })
      })
    },
  }
}
