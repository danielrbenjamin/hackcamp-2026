import type { Plugin } from 'vite'
import { MAX_DEPTH_POINTS, MAX_DEPTH_PREVIEW_DIMENSION } from '../shared/contracts'
import { validHazards } from '../shared/hazards'
import { validScanPose } from '../shared/roomScan'

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
          if (body.length > 144_000) request.destroy()
        })
        request.on('end', () => {
          try {
            const frame = JSON.parse(body)
            const observation = frame?.observation
            const grid = observation?.grid
            const points = observation?.points
            const preview = observation?.depthPreview
            const validPreview = preview === undefined || (preview && [preview.width, preview.height].every(
              size => Number.isInteger(size) && size > 0 && size <= MAX_DEPTH_PREVIEW_DIMENSION) &&
              typeof preview.samples === 'string' && preview.samples.length === 4 * Math.ceil(preview.width * preview.height * 2 / 3) &&
              /^[A-Za-z0-9+/]+={0,2}$/.test(preview.samples) &&
              Buffer.from(preview.samples, 'base64').length === preview.width * preview.height * 2)
            const validPoints = points === undefined || (Array.isArray(points) && points.length <= MAX_DEPTH_POINTS &&
              points.every(point => Array.isArray(point) && point.length === 3 && point.every(Number.isFinite)))
            if (frame?.schemaVersion !== 1 || !Number.isFinite(observation?.timeMs) ||
              !Array.isArray(observation?.zones) || observation.zones.length !== 5 ||
              grid?.width !== 40 || grid.height !== 20 || !Array.isArray(grid.cells) || grid.cells.length !== 800 ||
              observation.depth !== undefined || observation.pose !== undefined || !validPoints || !validPreview ||
              (observation.scanPose !== undefined && (!points?.length || !validScanPose(observation.scanPose))) ||
              (observation.hazards !== undefined && !validHazards(observation.hazards)) ||
              !Array.isArray(frame.command?.motors) || frame.command.motors.length !== 5 || !frame.route || !frame.belt) {
              response.writeHead(400).end()
              return
            }
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
