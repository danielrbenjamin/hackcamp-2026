import { HAZARD_LABELS, MAX_HAZARDS, type Hazard, type Heading } from './contracts.ts'

export function validHazards(value: unknown): value is readonly Hazard[] {
  const tuple = (data: unknown, size: number, bound: number): data is number[] =>
    Array.isArray(data) && data.length === size && data.every(n => Number.isFinite(n) && Math.abs(n) <= bound)
  return Array.isArray(value) && value.length <= MAX_HAZARDS && value.every(hazard => {
    if (!hazard || !Object.hasOwn(HAZARD_LABELS, hazard.kind) ||
        !Number.isFinite(hazard.confidence) || hazard.confidence < 0 || hazard.confidence > 1) return false
    if ('position' in hazard) return tuple(hazard.position, 3, 10) &&
      (hazard.predictedPosition === undefined || tuple(hazard.predictedPosition, 3, 10))
    const { bearing } = hazard
    return tuple(bearing, 2, 90) && bearing[0] <= bearing[1]
  })
}

export function blocksCorridor(hazard: Hazard, heading: Heading): boolean {
  if ('bearing' in hazard) {
    const margin = hazard.kind === 'glass' ? 5 : 20
    return heading + margin >= hazard.bearing[0] && heading - margin <= hazard.bearing[1]
  }

  const angle = heading * Math.PI / 180
  const sin = Math.sin(angle)
  const cos = Math.cos(angle)
  const [x, , z] = hazard.position
  const [nextX, , nextZ] = hazard.predictedPosition ?? hazard.position
  const lateral = x * cos - z * sin
  const forward = x * sin + z * cos
  const deltaLateral = (nextX - x) * cos - (nextZ - z) * sin
  const deltaForward = (nextX - x) * sin + (nextZ - z) * cos

  // Clip the current-to-predicted segment against the walking corridor.
  let enter = 0
  let exit = 1
  for (const [origin, delta, min, max] of [
    [lateral, deltaLateral, -0.45, 0.45],
    [forward, deltaForward, 0, 1.5],
  ]) {
    if (delta === 0) {
      if (origin < min || origin > max) return false
      continue
    }
    const start = (min - origin) / delta
    const end = (max - origin) / delta
    enter = Math.max(enter, Math.min(start, end))
    exit = Math.min(exit, Math.max(start, end))
    if (enter > exit) return false
  }
  return true
}
