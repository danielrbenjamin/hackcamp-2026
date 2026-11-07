export const ZONE_NAMES = ['Far left', 'Left', 'Ahead', 'Right', 'Far right'] as const
export const HEADINGS = [-60, -45, -30, -15, 0, 15, 30, 45, 60] as const
export type Five<T> = readonly [T, T, T, T, T]
export type Heading = typeof HEADINGS[number]
export type Cell = 0 | 1 | 2 // unknown, observed free, occupied
export type DepthPoint = readonly [right: number, up: number, forward: number]
export const MAX_DEPTH_POINTS = 900

export interface Grid {
  width: number
  height: number
  cellM: number
  cells: readonly Cell[]
}

export interface Observation {
  source: 'simulated' | 'arkit'
  timeMs: number
  zones: Five<number | null>
  grid: Grid
  // Column-major camera-to-world transform in metres, with a gravity-aligned up axis.
  pose?: number[]
  // Monotonic time since device boot when available.
  sensorTimeMs?: number
  forwardTrueHeading?: number
  points?: readonly DepthPoint[]
  depth?: {
    width: number
    height: number
    intrinsics: number[]
    meters: (number | null)[]
    confidence: number[]
  }
}

export interface Prediction {
  version: string
  scores: readonly number[]
  latencyMs: number
}

export interface Route {
  status: 'idle' | 'guiding' | 'rerouting'
  source: 'simulated' | 'google'
  destination: string
  desiredHeading: number | null
  trueBearing?: number
  updatedAtMs?: number
  maneuver: string
}

export interface BeltStatus {
  connected: boolean
  battery: number | null
  source: 'simulated' | 'ble'
}

export type Cue = 'idle' | 'direction' | 'obstacle' | 'unavailable'
export interface MotorCommand {
  cue: Cue
  motors: Five<number>
}

export interface Telemetry {
  schemaVersion: 1
  observation: Observation
  prediction: Prediction | null
  route: Route
  belt: BeltStatus
  command: MotorCommand
  heading: Heading | null
  baselineHeading?: Heading | null
  reflex: 'clear' | 'obstacle' | 'unknown'
  reflexDispatchMs?: number
}

export interface Providers {
  lidar: () => Observation
  model: (grid: Grid) => Promise<Prediction | null>
  navigation: () => Route
  belt: {
    status: () => BeltStatus
    send: (command: MotorCommand) => void
  }
}
