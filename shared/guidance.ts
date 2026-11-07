import { HEADINGS, type Heading, type MotorCommand, type Observation, type Prediction, type Providers, type Route, type Telemetry } from './contracts.ts'

export const IDLE: MotorCommand = { cue: 'idle', motors: [0, 0, 0, 0, 0] }
const OBSTACLE: MotorCommand = { cue: 'obstacle', motors: [1, 1, 1, 1, 1] }
const UNAVAILABLE: MotorCommand = { cue: 'unavailable', motors: [0, 0, 0, 0, 0] }
const MAX_AGE_MS = 600

function zoneIndex(heading: Heading): 0 | 1 | 2 | 3 | 4 {
  if (heading <= -45) return 0
  if (heading < 0) return 1
  if (heading === 0) return 2
  if (heading < 45) return 3
  return 4
}

function validClearance(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0
}

export function reflex(observation: Observation, now: number): Telemetry['reflex'] {
  const age = now - observation.timeMs
  if (!Number.isFinite(age) || age < 0 || age > MAX_AGE_MS) return 'unknown'
  const forward = observation.zones.slice(1, 4)
  if (forward.some(value => validClearance(value) && value < 0.85)) return 'obstacle'
  return forward.every(validClearance) ? 'clear' : 'unknown'
}

export function selectHeading(observation: Observation, prediction: Prediction | null, route: Route, previous: Heading | null): Heading | null {
  if (route.status !== 'guiding' || route.desiredHeading === null || !Number.isFinite(route.desiredHeading)) return null
  let selected: Heading | null = null
  let best = -Infinity
  for (const [index, heading] of HEADINGS.entries()) {
    const clearance = observation.zones[zoneIndex(heading)]
    if (!validClearance(clearance) || clearance < 1.4) continue
    if (observation.source === 'arkit' && !hasObservedCorridor(observation.grid, heading)) continue
    const modelScore = prediction ? prediction.scores[index] : 0.65
    if (!Number.isFinite(modelScore) || modelScore < 0.45 || modelScore > 1) continue
    const delta = Math.abs(((heading - route.desiredHeading) % 360 + 540) % 360 - 180)
    if (delta > 75) continue
    const score = modelScore + Math.min(clearance, 5) * 0.06 - delta * 0.012 + (heading === previous ? 0.09 : 0)
    if (score > best) {
      selected = heading
      best = score
    }
  }
  return selected
}

function hasObservedCorridor(grid: Observation['grid'], heading: Heading): boolean {
  const radians = heading * Math.PI / 180
  for (let distance = 0.5; distance <= 1.25; distance += 0.25) {
    for (const offset of [-0.2, 0, 0.2]) {
      const x = Math.sin(radians) * distance + Math.cos(radians) * offset
      const y = Math.cos(radians) * distance - Math.sin(radians) * offset
      const col = Math.floor(grid.width / 2 + x / grid.cellM)
      const row = grid.height - 1 - Math.floor(y / grid.cellM)
      if (col < 0 || col >= grid.width || row < 0 || row >= grid.height || grid.cells[row * grid.width + col] !== 1) return false
    }
  }
  return true
}

export function createLoop(providers: Providers, allowNativeGuidance = false) {
  let previous: Heading | null = null
  let previousBaseline: Heading | null = null
  let latest: { observation: Observation; prediction: Prediction | null } | null = null
  let pending = false
  let active = true
  let previousCommand: string | undefined
  let sentAt = -Infinity
  let reflexDispatchMs: number | undefined

  return {
    tick(now?: number): Telemetry {
      const observation = providers.lidar()
      const time = now ?? Date.now()
      const hazard = reflex(observation, time)
      const route = providers.navigation()
      const belt = providers.belt.status()
      const prediction = hazard === 'clear' && latest && observation.source === latest.observation.source &&
        Math.abs(observation.timeMs - latest.observation.timeMs) <= MAX_AGE_MS ? latest.prediction : null
      const eligible = hazard === 'clear' && (observation.source === 'simulated' || (allowNativeGuidance && route.source === 'google'))
      const baselineHeading = eligible ? selectHeading(observation, null, route, previousBaseline) : null
      const heading = eligible && prediction ? selectHeading(observation, prediction, route, previous) : baselineHeading
      previous = heading
      previousBaseline = baselineHeading
      let command = IDLE
      if (hazard === 'obstacle') command = OBSTACLE
      else if (hazard === 'unknown') command = UNAVAILABLE
      else if (heading !== null) {
        const motors: [number, number, number, number, number] = [0, 0, 0, 0, 0]
        motors[zoneIndex(heading)] = 0.7
        command = { cue: 'direction', motors }
      }
      const key = JSON.stringify(command)
      if (hazard !== 'obstacle' || !belt.connected) reflexDispatchMs = undefined
      if (active && belt.connected && (key !== previousCommand || (belt.source === 'ble' && time - sentAt >= 200))) {
        providers.belt.send(command)
        if (belt.source === 'ble' && hazard === 'obstacle' && reflexDispatchMs === undefined) {
          reflexDispatchMs = Math.max(0, (now ?? Date.now()) - observation.timeMs)
        }
        previousCommand = key
        sentAt = time
      }
      if (!belt.connected) previousCommand = undefined

      if (active && !pending && hazard === 'clear' && latest?.observation.timeMs !== observation.timeMs) {
        pending = true
        void Promise.resolve().then(() => providers.model(observation.grid)).then(
          result => { latest = { observation, prediction: result } },
          () => { latest = { observation, prediction: null } },
        ).finally(() => { pending = false })
      }
      return { schemaVersion: 1, observation, prediction, route, belt, command, heading, baselineHeading,
        reflex: hazard, reflexDispatchMs }
    },
    stop() {
      active = false
      if (providers.belt.status().connected) providers.belt.send(IDLE)
    },
  }
}
