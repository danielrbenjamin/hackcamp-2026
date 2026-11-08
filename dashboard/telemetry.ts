import type { Plugin } from 'vite'
import { MAX_DEPTH_POINTS } from '../shared/contracts'
import { validHazards } from '../shared/hazards'

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
          if (body.length > 72_000) request.destroy()
        })
        request.on('end', () => {
          try {
            const frame = JSON.parse(body)
            const observation = frame?.observation
            const grid = observation?.grid
            const points = observation?.points
            const validPoints = points === undefined || (Array.isArray(points) && points.length <= MAX_DEPTH_POINTS &&
              points.every(point => Array.isArray(point) && point.length === 3 && point.every(Number.isFinite)))
            if (frame?.schemaVersion !== 1 || !Number.isFinite(observation?.timeMs) ||
              !Array.isArray(observation?.zones) || observation.zones.length !== 5 ||
              grid?.width !== 40 || grid.height !== 20 || !Array.isArray(grid.cells) || grid.cells.length !== 800 ||
              observation.depth !== undefined || observation.pose !== undefined || !validPoints ||
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
