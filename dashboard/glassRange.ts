import type { DenseScan, ModelPreview } from '../shared/contracts'

type Edge = { right: number; up: number; forward: number }
type EdgePair = [Edge, Edge]

export function estimateGlassRange(scan: DenseScan, masks: ModelPreview['masks']) {
  const mask = masks.find(item => item.kind === 'glass')
  if (!mask) return undefined
  const labels = atob(mask.labels)
  if (!labels.includes('\x01')) return undefined
  const samples = Uint8Array.from(atob(scan.samples), byte => byte.charCodeAt(0))
  const depths = new DataView(samples.buffer)
  const [fx, fy, cx, cy] = scan.intrinsics
  const [xx, xy, xz, yx, yy, yz, zx, zy, zz] = scan.basis
  // Sweep across the upright image even when the sensor raster is sideways.
  const sideways = Math.abs(xy) > Math.abs(yy)
  const across = sideways ? scan.height : scan.width
  const down = sideways ? scan.width : scan.height
  const band = Math.max(2, Math.round(across * 0.015))
  const pixel = (col: number, row: number) => sideways ? col * scan.width + row : row * scan.width + col
  const inside = (index: number) => {
    const x = Math.floor((index % scan.width + 0.5) * mask.size / scan.width)
    const y = Math.floor((Math.floor(index / scan.width) + 0.5) * mask.size / scan.height)
    return labels.charCodeAt(y * mask.size + x) === 1
  }
  const depthAt = (index: number) => {
    const depth = depths.getFloat32(index * 8, true)
    return samples[index * 8 + 7] === 2 && depth >= 0.2 && depth <= 5 ? depth : undefined
  }
  function edgeAt(col: number, row: number, outward: number): Edge | undefined {
    const returns: { depth: number; index: number }[] = []
    for (let step = 1; step <= band; step++) {
      const index = pixel(col + step * outward, row)
      const depth = depthAt(index)
      if (depth !== undefined && !inside(index)) returns.push({ depth, index })
    }
    if (returns.length < 2) return undefined
    returns.sort((a, b) => a.depth - b.depth)
    if (returns[returns.length - 1].depth - returns[0].depth > 0.1) return undefined
    const { depth, index } = returns[Math.floor(returns.length / 2)]
    // Reject continuous surfaces with no depth break at the mask edge.
    for (let step = 1; step <= band; step++) {
      const innerDepth = depthAt(pixel(col - step * outward, row))
      if (innerDepth !== undefined && innerDepth < depth + 0.15) return undefined
    }
    const x = (index % scan.width + 0.5 - cx) * depth / fx
    const y = (cy - Math.floor(index / scan.width) - 0.5) * depth / fy
    return {
      right: xx * x + yx * y + zx * depth,
      up: xy * x + yy * y + zy * depth,
      forward: xz * x + yz * y + zz * depth,
    }
  }

  const pairs: EdgePair[] = []
  for (let row = 0; row < down; row += Math.max(1, Math.floor(down / 32))) {
    let first = 0
    while (first < across && !inside(pixel(first, row))) first++
    let end = first
    while (end < across && inside(pixel(end, row))) end++
    if (first < band || end - first < 2 * band + 1 || end + band > across) continue
    let next = end
    while (next < across && !inside(pixel(next, row))) next++
    if (next < across) continue
    const left = edgeAt(first, row, -1)
    const right = edgeAt(end - 1, row, 1)
    if (left && right) pairs.push([left, right])
  }

  // In gravity-aligned coordinates, a vertical plane is a line in right/forward.
  // Fit from opposing edges and require both edges of each inlier to agree.
  let best: { count: number; error: number; range: number } | undefined
  for (const [a, b] of pairs) {
    const width = Math.hypot(b.right - a.right, b.forward - a.forward)
    if (width < 0.25) continue
    const nr = (a.forward - b.forward) / width
    const nf = (b.right - a.right) / width
    const offset = nr * a.right + nf * a.forward
    const residual = (edge: Edge) => Math.abs(nr * edge.right + nf * edge.forward - offset)
    const inliers = pairs.filter(([left, right]) => residual(left) <= 0.08 && residual(right) <= 0.08)
    if (inliers.length < Math.max(4, Math.ceil(pairs.length * 0.7))) continue
    const points = inliers.flat()
    const heights = points.map(point => point.up)
    if (Math.max(...heights) - Math.min(...heights) < 0.25) continue
    const error = points.reduce((sum, point) => sum + residual(point), 0)
    if (best && (best.count > inliers.length || (best.count === inliers.length && best.error <= error))) continue
    const center = points.reduce(({ right, forward }, point) => ({
      right: right + point.right, forward: forward + point.forward,
    }), { right: 0, forward: 0 })
    const length = Math.hypot(center.right, center.forward)
    const projection = (nr * center.right + nf * center.forward) / length
    const range = offset / projection
    if (center.forward > 0 && Math.abs(projection) >= 0.35 && range >= 0.2 && range <= 5) {
      best = { count: inliers.length, error, range }
    }
  }
  return best?.range
}
