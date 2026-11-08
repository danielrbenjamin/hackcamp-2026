import type { DenseScan, ModelPreview } from '../shared/contracts'

export const MODEL_COLORS = { glass: 0x54cbed, riser: 0xf8a660, tread: 0xfbd77b }

// A bearing needs only a camera ray, not a depth return. Even a valid return
// behind glass does not establish the pane's distance.
export function glassBearing(scan: DenseScan, masks: ModelPreview['masks']) {
  const mask = masks.find(mask => mask.kind === 'glass')
  if (!mask) return undefined
  const labels = atob(mask.labels)
  const [fx, fy, cx, cy] = scan.intrinsics
  const [xx, , xz, yx, , yz, zx, , zz] = scan.basis
  const angles: number[] = []
  for (let i = 0; i < labels.length; i++) {
    if (labels.charCodeAt(i) !== 1) continue
    const x = ((i % mask.size + 0.5) / mask.size * scan.width - cx) / fx
    const y = -( (Math.floor(i / mask.size) + 0.5) / mask.size * scan.height - cy) / fy
    const right = xx * x + yx * y + zx
    const forward = xz * x + yz * y + zz
    if (forward > 0) angles.push(Math.atan2(right, forward) * 180 / Math.PI)
  }
  if (!angles.length) return undefined
  return angles.reduce((bounds, angle) => ({ left: Math.min(bounds.left, angle), right: Math.max(bounds.right, angle) }),
    { left: Infinity, right: -Infinity })
}

// Masks are already unpadded into normalized camera coordinates by iOS.
// Use original raster indices, never the compacted point-array index: invalid
// depth pixels have been removed from that array.
export function modelPointColors(scan: DenseScan, indices: readonly number[], masks: ModelPreview['masks']) {
  const layers = masks.map(mask => ({ ...mask, decoded: atob(mask.labels) }))
  const samples = atob(scan.samples)
  return indices.map(pixel => {
    const quality = samples.charCodeAt(pixel * 8 + 7)
    // Unknown/low confidence returns may be shown as geometry, but not labelled.
    if (quality !== 1 && quality !== 2) return undefined
    const u = (pixel % scan.width + 0.5) / scan.width
    const v = (Math.floor(pixel / scan.width) + 0.5) / scan.height
    let color: number | undefined
    for (const mask of layers) {
      const label = mask.decoded.charCodeAt(Math.floor(v * mask.size) * mask.size + Math.floor(u * mask.size))
      if (label === 1) color = mask.kind === 'glass' ? MODEL_COLORS.glass : MODEL_COLORS.riser
      else if (label === 2 && mask.kind === 'stairs') color = MODEL_COLORS.tread
    }
    return color
  })
}
