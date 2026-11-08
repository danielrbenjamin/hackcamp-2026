import type { DenseScan, DepthPoint } from '../shared/contracts'

export function scanDisplayRotation(scan: DenseScan | undefined): 0 | 90 | -90 | 180 {
  if (!scan) return 0
  const upAlongX = scan.basis[1]
  const upAlongY = scan.basis[4]
  if (Math.hypot(upAlongX, upAlongY) < 0.1) return 0
  if (Math.abs(upAlongX) > Math.abs(upAlongY)) return upAlongX < 0 ? 90 : -90
  return upAlongY < 0 ? 180 : 0
}

export function orientImagePoint(u: number, v: number, rotation: ReturnType<typeof scanDisplayRotation>): [number, number] {
  switch (rotation) {
    case 90: return [1 - v, u]
    case -90: return [v, 1 - u]
    case 180: return [1 - u, 1 - v]
    default: return [u, v]
  }
}

// Inverse of the camera-to-phone basis used to reconstruct scan returns.
export function scanImagePoint(scan: DenseScan, point: DepthPoint): [number, number] | undefined {
  const [right, up, forward] = point
  const [xx, xy, xz, yx, yy, yz, zx, zy, zz] = scan.basis
  const x = xx * right + xy * up + xz * forward
  const y = yx * right + yy * up + yz * forward
  const z = zx * right + zy * up + zz * forward
  if (!Number.isFinite(z) || z < 0.08) return undefined
  const [fx, fy, cx, cy] = scan.intrinsics
  return [(fx * x / z + cx) / scan.width, (cy - fy * y / z) / scan.height]
}

export function decodeDenseScan(scan: DenseScan) {
  const decoded = atob(scan.samples)
  const bytes = Uint8Array.from(decoded, value => value.charCodeAt(0))
  const data = new DataView(bytes.buffer)
  const points: DepthPoint[] = []
  const colors: number[] = []
  const indices: number[] = []
  const depths: number[] = []
  const [fx, fy, cx, cy] = scan.intrinsics
  const [xx, xy, xz, yx, yy, yz, zx, zy, zz] = scan.basis
  for (let index = 0; index < scan.width * scan.height; index++) {
    const offset = index * 8
    const depth = data.getFloat32(offset, true)
    if (!Number.isFinite(depth) || depth <= 0) continue
    const x = (index % scan.width + 0.5 - cx) * depth / fx
    const y = -(Math.floor(index / scan.width) + 0.5 - cy) * depth / fy
    points.push([xx * x + yx * y + zx * depth, xy * x + yy * y + zy * depth, xz * x + yz * y + zz * depth])
    if (scan.cameraColor) colors.push(bytes[offset + 4] * 65_536 + bytes[offset + 5] * 256 + bytes[offset + 6])
    indices.push(index)
    depths.push(depth)
  }
  return { points, colors, indices, depths }
}

export const SCAN_HISTORY_MS = 1500
export type ScanFrame = { scan: DenseScan; decoded: ReturnType<typeof decodeDenseScan> }

export function fillScanGaps({ scan, decoded }: ScanFrame, history: readonly ScanFrame[]) {
  const tracking = scan.tracking
  if (!tracking || !history.length) return { ...decoded, filled: 0 }

  const pixels = new Uint8Array(scan.width * scan.height)
  for (const index of decoded.indices) pixels[index] = 1
  const [fx, fy, cx, cy] = scan.intrinsics
  const [xx, xy, xz, yx, yy, yz, zx, zy, zz] = scan.basis
  const points = decoded.points.slice()
  const colors = decoded.colors.slice()
  const indices = decoded.indices.slice()
  const depths = decoded.depths.slice()
  const nearest = new Map<number, { point: DepthPoint; depth: number; color?: number }>()

  // Use the newest frame that covers each gap, with a depth test within that frame.
  for (const previous of history) {
    const pose = previous.scan.tracking
    const age = scan.timeMs - previous.scan.timeMs
    if (!pose || pose.session !== tracking.session || age <= 0 || age > SCAN_HISTORY_MS) continue
    const [right, up, forward] = pose.position.map((value, axis) => value - tracking.position[axis])
    if (Math.hypot(right, up, forward) > 1) continue
    const cos = Math.cos(pose.yaw - tracking.yaw)
    const sin = Math.sin(pose.yaw - tracking.yaw)
    const offsetRight = right * Math.cos(tracking.yaw) - forward * Math.sin(tracking.yaw)
    const offsetForward = right * Math.sin(tracking.yaw) + forward * Math.cos(tracking.yaw)
    nearest.clear()
    previous.decoded.points.forEach(([r, u, f], index) => {
      const x = r * cos + f * sin + offsetRight
      const y = u + up
      const z = f * cos - r * sin + offsetForward
      const depth = x * zx + y * zy + z * zz
      if (depth <= 0) return
      const col = Math.floor(fx * (x * xx + y * xy + z * xz) / depth + cx)
      const row = Math.floor(cy - fy * (x * yx + y * yy + z * yz) / depth)
      if (!(col >= 0 && col < scan.width && row >= 0 && row < scan.height)) return
      const pixel = row * scan.width + col
      if (pixels[pixel] || depth >= (nearest.get(pixel)?.depth ?? Infinity)) return
      nearest.set(pixel, { point: [x, y, z], depth, color: previous.decoded.colors[index] })
    })
    for (const [pixel, sample] of nearest) {
      pixels[pixel] = 1
      if (sample.color !== undefined) colors[points.length] = sample.color
      points.push(sample.point)
      indices.push(pixel)
      depths.push(sample.depth)
    }
  }
  return { points, colors, indices, depths, filled: points.length - decoded.points.length }
}
