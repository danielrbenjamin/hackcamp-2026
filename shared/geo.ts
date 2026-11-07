export interface Coordinate { lat: number; lng: number }

export function relativeHeading(from: Coordinate, to: Coordinate, trueHeading: number): number | null {
  if (![from.lat, from.lng, to.lat, to.lng, trueHeading].every(Number.isFinite) || trueHeading < 0) return null
  const radians = Math.PI / 180
  const delta = (to.lng - from.lng) * radians
  const a = from.lat * radians
  const b = to.lat * radians
  const east = Math.sin(delta) * Math.cos(b)
  const north = Math.cos(a) * Math.sin(b) - Math.sin(a) * Math.cos(b) * Math.cos(delta)
  if (Math.hypot(east, north) < 1e-8) return null
  const bearing = Math.atan2(east, north) / radians
  return ((bearing - trueHeading + 540) % 360) - 180
}

export function routeBearing(location: Coordinate, path: readonly Coordinate[]): number | null {
  const longitudeScale = Math.cos(location.lat * Math.PI / 180)
  const local = path.map(point => [(point.lng - location.lng) * longitudeScale, point.lat - location.lat] as const)
  let bestDistance = Infinity
  let bestIndex = -1
  let fraction = 0
  for (let i = 1; i < local.length; i++) {
    const [x, y] = local[i - 1]
    const dx = local[i][0] - x
    const dy = local[i][1] - y
    const lengthSquared = dx * dx + dy * dy
    if (!lengthSquared) continue
    const t = Math.max(0, Math.min(1, -(x * dx + y * dy) / lengthSquared))
    const distance = Math.hypot(x + t * dx, y + t * dy)
    if (distance < bestDistance) {
      bestDistance = distance
      bestIndex = i
      fraction = t
    }
  }
  if (bestIndex < 0 || bestDistance > 0.0002) return null
  const before = path[bestIndex - 1]
  const after = path[bestIndex]
  let from = { lat: before.lat + (after.lat - before.lat) * fraction,
    lng: before.lng + (after.lng - before.lng) * fraction }
  for (let i = bestIndex; i < path.length; i++) {
    const bearing = relativeHeading(from, path[i], 0)
    if (bearing !== null) return (bearing + 360) % 360
    from = path[i]
  }
  return null
}
