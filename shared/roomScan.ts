import type { DepthPoint, ScanPose } from './contracts.ts'

export function scanPose(pose: number[] | undefined, initial: number[], session: string): ScanPose | undefined {
  if (!pose || pose.length !== 16 || initial.length !== 16 ||
      !pose.every(Number.isFinite) || !initial.every(Number.isFinite)) return
  if (Math.hypot(pose[8], pose[10]) < 0.4 || Math.hypot(initial[8], initial[10]) < 0.4) return
  const reference = Math.atan2(-initial[8], initial[10])
  const sin = Math.sin(reference)
  const cos = Math.cos(reference)
  const x = pose[12] - initial[12]
  const z = pose[14] - initial[14]
  const yaw = Math.atan2(-pose[8], pose[10]) - reference
  return { session, origin: [x * cos + z * sin, pose[13] - initial[13], x * sin - z * cos], yaw }
}

export interface ScanPoint {
  position: DepthPoint
  rgb?: number
}

export function addScanFrame(voxels: Map<string, ScanPoint>, points: readonly DepthPoint[], pose: ScanPose, colors?: readonly number[]) {
  const sin = Math.sin(pose.yaw)
  const cos = Math.cos(pose.yaw)
  points.forEach(([right, up, forward], index) => {
    const point: DepthPoint = [
      pose.origin[0] + right * cos + forward * sin,
      pose.origin[1] + up,
      pose.origin[2] - right * sin + forward * cos,
    ]
    const key = point.map(value => Math.floor(value / 0.04)).join(',')
    voxels.set(key, { position: point, rgb: colors?.[index] ?? voxels.get(key)?.rgb })
  })
  for (const key of voxels.keys()) {
    if (voxels.size <= 24_000) break
    voxels.delete(key)
  }
}

export function validScanPose(value: unknown): value is ScanPose {
  if (!value || typeof value !== 'object') return false
  const { session, origin, yaw } = value as Partial<ScanPose>
  return typeof session === 'string' && session.length > 0 && session.length <= 64 &&
    Array.isArray(origin) && origin.length === 3 && origin.every(Number.isFinite) &&
    typeof yaw === 'number' && Number.isFinite(yaw) && Math.abs(yaw) <= 2 * Math.PI
}
