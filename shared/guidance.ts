import { HEADINGS, type Heading, type MotorCommand, type Observation, type Providers, type Route, type Telemetry } from './contracts.ts'
import { blocksCorridor, validHazards } from './hazards.ts'

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

export function selectHeading(observation: Observation, route: Route, previous: Heading | null,
  blocked: readonly Heading[] = []): Heading | null {
  if (route.status !== 'guiding' || route.desiredHeading === null || !Number.isFinite(route.desiredHeading)) return null
  let selected: Heading | null = null
  let best = -Infinity
  for (const heading of HEADINGS) {
    if (blocked.includes(heading)) continue
    const clearance = observation.zones[zoneIndex(heading)]
    if (!validClearance(clearance) || clearance < 1.4) continue
    if (!hasObservedCorridor(observation.grid, heading)) continue
    const delta = Math.abs(((heading - route.desiredHeading) % 360 + 540) % 360 - 180)
    if (delta > 75) continue
    const score = Math.min(clearance, 5) * 0.06 - delta * 0.012 + (heading === previous ? 0.09 : 0)
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
      const eligible = hazard === 'clear' &&
        (observation.source === 'simulated' || (allowNativeGuidance && belt.connected && route.source === 'google'))
      const detections = observation.hazards
      const blockedHeadings = hazard !== 'clear' || detections === undefined ? []
        : validHazards(detections) ? HEADINGS.filter(heading => detections.some(detection => blocksCorridor(detection, heading)))
        : HEADINGS
      const baselineHeading = eligible ? selectHeading(observation, route, previousBaseline) : null
      const heading = eligible ? selectHeading(observation, route, previous, blockedHeadings) : null
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

      return { schemaVersion: 1, observation, prediction: null, route, belt, command, heading, baselineHeading, blockedHeadings,
        reflex: hazard, reflexDispatchMs }
    },
    stop() {
      active = false
      if (providers.belt.status().connected) providers.belt.send(IDLE)
    },
  }
}
