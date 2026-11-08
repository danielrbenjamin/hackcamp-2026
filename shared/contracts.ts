export const ZONE_NAMES = ['Far left', 'Left', 'Ahead', 'Right', 'Far right'] as const
export const HEADINGS = [-60, -45, -30, -15, 0, 15, 30, 45, 60] as const
export type Five<T> = readonly [T, T, T, T, T]
export type Heading = typeof HEADINGS[number]
export type Cell = 0 | 1 | 2 // unknown, observed free, occupied
export type DepthPoint = readonly [right: number, up: number, forward: number]
export const MAX_DEPTH_POINTS = 6_000
export const MAX_DEPTH_PREVIEW_DIMENSION = 256
export interface DepthPreview {
  width: number
  height: number
  // Base64, row-major little-endian words. Low 14 bits are centimetres (0 = missing).
  // The high two bits are ARKit confidence.
  samples: string
}

export interface ModelPreview {
  timeMs: number
  latencyMs: number
  depthPreview?: DepthPreview
  models: Record<'glass' | 'stairs' | 'person', string>
  masks: { kind: 'glass' | 'stairs'; size: number; labels: string; points: readonly DepthPoint[] }[]
  people: { box: readonly [number, number, number, number]; confidence: number; position?: DepthPoint; predictedPosition?: DepthPoint }[]
}
export const MAX_HAZARDS = 32
export const HAZARD_LABELS = { stairs: 'Possible descending stairs', glass: 'Possible glass', person: 'Person' } as const

// Coordinates are in the same phone-relative frame as the observation's scan.
export type Hazard = { kind: keyof typeof HAZARD_LABELS; confidence: number } & (
  | { position: DepthPoint; predictedPosition?: DepthPoint }
  | { bearing: readonly [leftDegrees: number, rightDegrees: number] }
)

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
  // Base64 RGB bytes in the same order as points. Sent only with scan sharing.
  pointColors?: string
  depthPreview?: DepthPreview
  smoothedDepthPreview?: DepthPreview
  // Frame-aligned detections. Undefined means unavailable; [] means no detections.
  hazards?: readonly Hazard[]
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
  modelPreview?: ModelPreview
  schemaVersion: 1
  observation: Observation
  prediction: Prediction | null
  route: Route
  belt: BeltStatus
  command: MotorCommand
  heading: Heading | null
  baselineHeading?: Heading | null
  blockedHeadings?: readonly Heading[]
  reflex: 'clear' | 'obstacle' | 'unknown'
  reflexDispatchMs?: number
}

export interface Providers {
  lidar: () => Observation
  navigation: () => Route
  belt: {
    status: () => BeltStatus
    send: (command: MotorCommand) => void
  }
}
