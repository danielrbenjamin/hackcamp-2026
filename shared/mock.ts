import { HEADINGS, type Cell, type Five, type Grid, type MotorCommand, type Observation, type Providers } from './contracts.ts'

export type Scenario = 'walk' | 'obstacle' | 'dropout'
export const GRID_WIDTH = 40
export const GRID_HEIGHT = 20
export const CELL_M = 0.25

function sampleGrid(time: number, scenario: Scenario): Grid {
  const cells = Array.from({ length: GRID_WIDTH * GRID_HEIGHT }, (_, i): Cell => {
    const x = (i % GRID_WIDTH - 19.5) * CELL_M
    const y = (GRID_HEIGHT - 0.5 - Math.floor(i / GRID_WIDTH)) * CELL_M
    if (scenario === 'dropout' || Math.abs(x) > y * 1.65 || Math.hypot(x, y) > 5) return 0
    const wall = Math.abs(x + 1.45) < 0.2 && y > 1.25
    const post = Math.hypot(x - 1.5, y - 2.7 - 0.35 * Math.sin(time)) < 0.45
    const obstacle = scenario === 'obstacle' && Math.abs(x) < 0.4 && y > 0.4 && y < 0.85
    return wall || post || obstacle ? 2 : 1
  })
  return { width: GRID_WIDTH, height: GRID_HEIGHT, cellM: CELL_M, cells }
}

export function emptyObservation(): Observation {
  return { source: 'arkit', timeMs: 0, zones: [null, null, null, null, null], grid: sampleGrid(0, 'dropout') }
}

export function createMock() {
  const start = Date.now()
  let scenario: Scenario = 'walk'
  let connected = true
  let destination = 'Engineering Design Centre'
  let lastCommand: MotorCommand | null = null
  const elapsed = () => (Date.now() - start) / 1000
  const providers: Providers = {
    lidar() {
      const time = elapsed()
      const zones: Five<number | null> = scenario === 'dropout' ? [null, null, null, null, null]
        : [1.6, 2.4, scenario === 'obstacle' ? 0.62 : 4.1, 3.4 + 0.35 * Math.sin(time), 2.2]
      return { source: 'simulated', timeMs: Date.now(), zones, grid: sampleGrid(time, scenario) }
    },
    async model(grid) {
      const before = performance.now()
      const scores = HEADINGS.map(heading => {
        const radians = heading * Math.PI / 180
        let score = 1
        for (let distance = 0.5; distance < 3.5; distance += grid.cellM) {
          const col = Math.floor(grid.width / 2 + Math.sin(radians) * distance / grid.cellM)
          const row = grid.height - 1 - Math.floor(Math.cos(radians) * distance / grid.cellM)
          const cell = grid.cells[row * grid.width + col]
          if (cell !== 1) score -= 0.06
        }
        return Math.max(0, score)
      })
      return { version: 'mock-grid-v1', scores, latencyMs: performance.now() - before }
    },
    navigation: () => ({
      source: 'simulated',
      status: destination ? 'guiding' : 'idle',
      destination,
      desiredHeading: destination ? 25 * Math.sin(elapsed() / 5) : null,
      maneuver: destination ? 'Follow the walkway' : 'Choose a destination',
    }),
    belt: {
      status: () => ({ connected, source: 'simulated', battery: connected ? 87 : null }),
      send: command => { lastCommand = command },
    },
  }
  return {
    providers,
    setScenario: (value: Scenario) => { scenario = value },
    setDestination: (value: string) => { destination = value.trim() },
    setConnected: (value: boolean) => { connected = value },
    lastCommand: () => lastCommand,
  }
}
