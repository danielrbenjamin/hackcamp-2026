import type { Plugin } from 'vite'
import { MAX_DEPTH_POINTS, MAX_DEPTH_PREVIEW_DIMENSION, MAX_SCAN_PIXELS, type DenseScan, type DepthPreview } from '../shared/contracts'
import { validHazards } from '../shared/hazards'
function validDenseScan(value: unknown) {
  if (value === undefined) return true
  if (!value || typeof value !== 'object') return false
  const { width, height, timeMs, intrinsics, basis, samples, cameraColor, tracking } = value as DenseScan
  if (![width, height].every(size => Number.isInteger(size) && size > 0 && size <= MAX_SCAN_PIXELS) ||
      width * height > MAX_SCAN_PIXELS || !Number.isFinite(timeMs) || typeof cameraColor !== 'boolean' ||
      !Array.isArray(intrinsics) || intrinsics.length !== 4 || !intrinsics.every(Number.isFinite) ||
      intrinsics[0] <= 0 || intrinsics[1] <= 0 || !Array.isArray(basis) || basis.length !== 9 ||
      !basis.every(value => Number.isFinite(value) && Math.abs(value) <= 1.001)) return false
  if (tracking !== undefined && (!tracking || typeof tracking.session !== 'string' ||
      tracking.session.length === 0 || tracking.session.length > 64 || !Array.isArray(tracking.position) ||
      tracking.position.length !== 3 || !tracking.position.every(Number.isFinite) ||
      !Number.isFinite(tracking.yaw) || Math.abs(tracking.yaw) > 3.15)) return false
  const bytes = width * height * 8
  return typeof samples === 'string' && samples.length === 4 * Math.ceil(bytes / 3) &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(samples) && Buffer.from(samples, 'base64').length === bytes
}
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
  const { timeMs, latencyMs, models, masks, people, depthPreview, partial, scan, denseScan } = preview as import('../shared/contracts').ModelPreview
  const point = (value: unknown) => Array.isArray(value) && value.length === 3 &&
    value.every(n => Number.isFinite(n) && Math.abs(n) <= 10)
  const validScan = scan === undefined || (!!scan && Array.isArray(scan.points) && scan.points.length > 0 &&
    scan.points.length <= MAX_DEPTH_POINTS && scan.points.every(point) &&
    (scan.imageCoordinates === undefined || (typeof scan.imageCoordinates === 'string' &&
      scan.imageCoordinates.length === 4 * Math.ceil(scan.points.length * 4 / 3) &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(scan.imageCoordinates) &&
      Buffer.from(scan.imageCoordinates, 'base64').length === scan.points.length * 4)) &&
    (scan.pointColors === undefined || (typeof scan.pointColors === 'string' &&
      scan.pointColors.length === scan.points.length * 4 && /^[A-Za-z0-9+/]+$/.test(scan.pointColors))))
  return validScan && validDenseScan(denseScan) && (!denseScan || denseScan.timeMs === timeMs) &&
    validPreview(depthPreview) && (partial === undefined || typeof partial === 'boolean') &&
    Number.isFinite(timeMs) && Number.isFinite(latencyMs) && latencyMs >= 0 &&
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
          if (body.length > 7_000_000) request.destroy()
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
              !validDenseScan(observation.denseScan) ||
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
