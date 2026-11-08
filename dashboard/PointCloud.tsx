import { useEffect, useMemo, useRef, useState } from 'react'
import { HAZARD_LABELS, type DepthPoint, type Grid, type Hazard, type Heading } from '../shared/contracts'
import { CloudCanvas } from './CloudCanvas'

const colors = ['#49608b', '#59a8b2', '#a1b979', '#e9ae6b']
const heightRgb = colors.map(color => parseInt(color.slice(1), 16))

function cameraColor(rgb: number): string {
  const channel = (shift: number) => Math.round(((rgb >> shift) & 7) * 255 / 7)
  return `rgb(${channel(21)},${channel(13)},${channel(5)})`
}

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

function frontBounds(points: readonly DepthPoint[] | undefined) {
  const x: number[] = []
  const y: number[] = []
  const step = Math.max(1, Math.floor((points?.length ?? 0) / 1_000))
  for (let i = 0; points && i < points.length; i += step) {
    const [right, up, forward] = points[i]
    if (forward < 0.08) continue
    x.push(right / forward)
    y.push(up / forward)
  }
  x.sort((a, b) => a - b)
  y.sort((a, b) => a - b)
  const trim = Math.floor(x.length * 0.02)
  const last = x.length - 1 - trim
  return { left: x[trim] ?? -0.5, right: x[last] ?? 0.5, bottom: y[trim] ?? -0.4, top: y[last] ?? 0.4 }
}

export function PointCloud({ points, pointColors, heading, hazards, phone, colorLabel, overlayPoints }: {
  points: readonly DepthPoint[] | undefined
  pointColors?: string
  heading: Heading | null
  hazards?: readonly Hazard[]
  phone: boolean
  colorLabel?: string
  overlayPoints?: readonly { point: DepthPoint; rgb: number }[]
}) {
  const [yaw, setYaw] = useState(-27)
  const [tilt, setTilt] = useState(36)
  const [angled, setAngled] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [fallback, setFallback] = useState(false)
  const scan = useRef<HTMLDivElement>(null)
  const [frameWidth, setFrameWidth] = useState(720)
  useEffect(() => {
    const element = scan.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      if (width > 0 && height > 0) setFrameWidth(Math.round(420 * width / height))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const rgb = useMemo(() => {
    if (!pointColors) return undefined
    const bytes = atob(pointColors)
    return Array.from({ length: bytes.length / 3 }, (_, index) => {
      const start = index * 3
      return bytes.charCodeAt(start) * 65_536 + bytes.charCodeAt(start + 1) * 256 + bytes.charCodeAt(start + 2)
    })
  }, [pointColors])
  const orbit = angled
  const hasCameraColor = !!rgb?.length
  const scale = 58 * zoom * (phone ? 1.6 : 1)
  const centerDepth = phone ? 1.75 : 2.5
  const bounds = useMemo(() => frontBounds(points), [points])
  const frontScale = zoom * Math.min(frameWidth * 0.94 / Math.max(0.15, bounds.right - bounds.left),
    420 * 0.90 / Math.max(0.15, bounds.top - bounds.bottom), 900)
  const frontX = (bounds.left + bounds.right) / 2
  const frontY = (bounds.bottom + bounds.top) / 2
  const centerX = frameWidth / 2
  const viewBox = `0 0 ${frameWidth} 420`
  const angle = (orbit ? yaw : 0) * Math.PI / 180
  const pitch = (orbit ? tilt : 0) * Math.PI / 180
  const sin = Math.sin(angle)
  const cos = Math.cos(angle)
  const pitchSin = Math.sin(pitch)
  const pitchCos = Math.cos(pitch)
  function projectPoint([right, up, forward]: DepthPoint) {
    if (!orbit) {
      const z = Math.max(0.08, forward)
      return [centerX + (right / z - frontX) * frontScale, 210 - (up / z - frontY) * frontScale, forward]
    }
    const depth = (forward - centerDepth) * cos - right * sin
    return [centerX + (right * cos + (forward - centerDepth) * sin) * scale,
      210 - (up * pitchCos + depth * pitchSin) * scale, depth * pitchCos - up * pitchSin]
  }
  const project = (point: DepthPoint) => projectPoint(point).slice(0, 2)
  const grid = Array.from({ length: 11 }, (_, i) => {
    const x = i - 5
    const depth = i / 2
    return [`M${project([x, -1.2, 0])}L${project([x, -1.2, 5])}`,
      `M${project([-5, -1.2, depth])}L${project([5, -1.2, depth])}`].join('')
  }).join('')
  const layers = new Map<string, string>()
  const vertexData = new Float32Array(((points?.length ?? 0) + (overlayPoints?.length ?? 0)) * 6)
  let offset = 0
  function addPoint(point: DepthPoint, pointRgb: number | undefined, overlay = false) {
    if (!orbit && point[2] < 0.08) return
    const [x, y, depth] = projectPoint(point)
    const layer = point[1] < -0.95 ? 0 : point[1] < -0.45 ? 1 : point[1] < 0.2 ? 2 : 3
    const color = pointRgb ?? heightRgb[layer]
    vertexData[offset++] = x / centerX - 1
    vertexData[offset++] = 1 - y / 210
    vertexData[offset++] = depth / (1 + Math.abs(depth)) - (overlay ? 0.002 : 0)
    vertexData[offset++] = (color >> 16) / 255
    vertexData[offset++] = ((color >> 8) & 255) / 255
    vertexData[offset++] = (color & 255) / 255
    if (fallback) {
      const stroke = pointRgb === undefined ? colors[layer] : cameraColor(pointRgb)
      layers.set(stroke, (layers.get(stroke) ?? '') + `M${x.toFixed(1)},${y.toFixed(1)}h2.1`)
    }
  }
  points?.forEach((point, index) => addPoint(point, rgb?.[index]))
  overlayPoints?.forEach(({ point, rgb }) => addPoint(point, rgb, true))
  const direction = (heading ?? 0) * Math.PI / 180
  const origin = project([0, -1.2, 0])
  const axes = [
    { label: 'X', end: project([0.65, -1.2, 0]), color: '#e5a288' },
    { label: 'Y', end: project([0, -0.55, 0]), color: '#a1b979' },
    { label: 'Z', end: project([0, -1.2, 0.65]), color: '#9dd9e8' },
  ]
  return <>
    <div className="scan" ref={scan}>
      {orbit && <svg viewBox={viewBox} className="cloud" aria-hidden="true">
        <path d={grid} fill="none" stroke="#293039" />
      </svg>}
      <CloudCanvas vertices={vertexData.subarray(0, offset)} frameWidth={frameWidth} onFallback={setFallback} />
      <svg viewBox={viewBox} className="cloud" role="img"
        aria-label={colorLabel ?? (hasCameraColor ? '3D LiDAR points with camera colors' : '3D LiDAR points colored by relative height')}>
        {[...layers].map(([color, path]) => <path key={color} d={path} fill="none" stroke={color} strokeWidth="2.1" />)}
        {orbit && axes.map(({ label, end, color }) => <g key={label}>
          <path d={`M${origin}L${end}`} stroke={color} />
          <text x={end[0] + 4} y={end[1] - 3} fill={color} fontSize="10">{label}</text>
        </g>)}
        {orbit && <circle cx={project([0, 0, 0])[0]} cy={project([0, 0, 0])[1]} r="4" fill="#c2f2ff" />}
        {orbit && heading !== null && <path d={`M${project([0, -1.18, 0])}L${project([Math.sin(direction) * 2, -1.18, Math.cos(direction) * 2])}`}
          stroke="#c2f2ff" strokeWidth="2" strokeDasharray="5 4" />}
        {hazards?.map((hazard, index) => {
          if (!('position' in hazard) || (!orbit && hazard.position[2] < 0.08)) return null
          const [x, y] = project(hazard.position)
          const color = hazard.kind === 'person' ? '#ffc373' : '#ff8d81'
          return <g key={index}>
            {hazard.predictedPosition && <path d={`M${x},${y}L${project(hazard.predictedPosition)}`}
              stroke={color} strokeWidth="2" strokeDasharray="5 4" />}
            <circle cx={x} cy={y} r="6" fill="none" stroke={color} strokeWidth="2" />
            <text x={x + 10} y={y - 8} fill={color} fontSize="12">{HAZARD_LABELS[hazard.kind]}</text>
          </g>
        })}
      </svg>
      <div className="scan-label">{phone ? 'ARKIT' : 'SIM'} / {points?.length ?? 0} points
        {fallback ? ' / SVG fallback' : ''}</div>
      {!points?.length && !hazards?.length && <p className="scan-empty">{!phone || points ? 'No depth returns' : 'Enable 3D scan sharing on the iPhone'}</p>}
    </div>
    <div className="legend">
      {colorLabel ? <span>{colorLabel}</span> : hasCameraColor ? <span>Camera color</span>
        : <span><i className="height-scale" />Height relative to phone</span>}
      <div className="scan-modes">
        <button aria-pressed={!angled} onClick={() => setAngled(false)}>Front</button>
        <button aria-pressed={angled} onClick={() => setAngled(true)}>Orbit</button>
      </div>
      <label className="orbit">Zoom <input type="range" min="0.6" max="2.5" step="0.05" value={zoom}
        onChange={event => setZoom(Number(event.target.value))} /></label>
      {orbit && <>
        <label className="orbit">Rotate <input type="range" min="-180" max="180" value={yaw}
          onChange={event => setYaw(Number(event.target.value))} /></label>
        <label className="orbit">Tilt <input type="range" min="0" max="80" value={tilt}
          onChange={event => setTilt(Number(event.target.value))} /></label>
      </>}
    </div>
  </>
}
