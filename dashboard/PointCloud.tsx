import { useState } from 'react'
import type { DepthPoint, Grid, Heading } from '../shared/contracts'

const colors = ['#49608b', '#59a8b2', '#a1b979', '#e9ae6b']

export function simulatedPoints(grid: Grid): DepthPoint[] {
  return grid.cells.flatMap((cell, index): DepthPoint[] => {
    if (cell === 0) return []
    const right = (index % grid.width + 0.5 - grid.width / 2) * grid.cellM
    const forward = (grid.height - Math.floor(index / grid.width) - 0.5) * grid.cellM
    if (cell === 1) return [[right, -1.2, forward], [right + 0.08, -1.2, forward + 0.08]]
    const top = right < -1 ? 0.85 : forward < 1 ? -0.25 : 0.25
    const surface: DepthPoint[] = []
    for (let up = -1.15; up <= top; up += 0.12) {
      surface.push([right, up, forward], [right + 0.08, up + 0.03, forward + 0.06])
    }
    return surface
  })
}

export function PointCloud({ points, heading, phone }: {
  points: readonly DepthPoint[] | undefined
  heading: Heading | null
  phone: boolean
}) {
  const [yaw, setYaw] = useState(-27)
  const angle = yaw * Math.PI / 180
  const sin = Math.sin(angle)
  const cos = Math.cos(angle)
  function project([right, up, forward]: DepthPoint) {
    return [360 + (right * cos + (forward - 2.5) * sin) * 58,
      212 - (up * 0.8 + ((forward - 2.5) * cos - right * sin) * 0.59) * 58]
  }
  const grid = Array.from({ length: 11 }, (_, i) => {
    const x = i - 5
    const depth = i / 2
    return [`M${project([x, -1.2, 0])}L${project([x, -1.2, 5])}`,
      `M${project([-5, -1.2, depth])}L${project([5, -1.2, depth])}`].join('')
  }).join('')
  const layers = colors.map(() => '')
  for (const point of points ?? []) {
    const [x, y] = project(point)
    const layer = point[1] < -0.95 ? 0 : point[1] < -0.45 ? 1 : point[1] < 0.2 ? 2 : 3
    layers[layer] += `M${x.toFixed(1)},${y.toFixed(1)}h2.1`
  }
  const direction = (heading ?? 0) * Math.PI / 180
  const origin = project([0, -1.2, 0])
  const axes = [
    { label: 'X', end: project([0.65, -1.2, 0]), color: '#e5a288' },
    { label: 'Y', end: project([0, -0.55, 0]), color: '#a1b979' },
    { label: 'Z', end: project([0, -1.2, 0.65]), color: '#9dd9e8' },
  ]
  return <>
    <div className="scan">
      <svg viewBox="0 0 720 420" className="cloud" role="img" aria-label="3D LiDAR points colored by relative height">
        <path d={grid} fill="none" stroke="#293039" />
        {layers.map((path, i) => <path key={colors[i]} d={path} fill="none" stroke={colors[i]} strokeWidth="2.1" />)}
        {axes.map(({ label, end, color }) => <g key={label}>
          <path d={`M${origin}L${end}`} stroke={color} />
          <text x={end[0] + 4} y={end[1] - 3} fill={color} fontSize="10">{label}</text>
        </g>)}
        <circle cx={project([0, 0, 0])[0]} cy={project([0, 0, 0])[1]} r="4" fill="#c2f2ff" />
        {heading !== null && <path d={`M${project([0, -1.18, 0])}L${project([Math.sin(direction) * 2, -1.18, Math.cos(direction) * 2])}`}
          stroke="#c2f2ff" strokeWidth="2" strokeDasharray="5 4" />}
      </svg>
      <div className="scan-label">{phone ? 'ARKIT' : 'SIM'} / {points?.length ?? 0} points</div>
      {!points?.length && <p className="scan-empty">{!phone ? 'No depth returns' : points ? 'No depth returns' : 'Enable 3D scan sharing on the iPhone'}</p>}
    </div>
    <div className="legend">
      <span><i className="height-scale" />Height relative to phone</span>
      <label className="orbit">Rotate <input type="range" min="-70" max="70" value={yaw}
        onChange={event => setYaw(Number(event.target.value))} /></label>
    </div>
  </>
}
