import { useEffect, useId, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { HAZARD_LABELS, type DenseScan, type DepthPoint, type DepthPreview, type Grid, type Hazard, type Heading, type ModelPreview } from '../shared/contracts'
import { CloudCanvas } from './CloudCanvas'
import { DEFAULT_DEPTH_RANGE_M, DepthRaster, distancePalette, renderDepthRaster } from './DepthImages'
import { decodeDenseScan, fillScanGaps, orientImagePoint, scanDisplayRotation, scanImagePoint, SCAN_HISTORY_MS, type ScanFrame } from './denseScan'
import { modelPointColors } from './modelColors'

const colors = ['#49608b', '#59a8b2', '#a1b979', '#e9ae6b']
const heightRgb = colors.map(color => parseInt(color.slice(1), 16))
const depthPalette = distancePalette(DEFAULT_DEPTH_RANGE_M * 100)
const depthRgb = depthPalette.map(([r, g, b]) => (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b))
const orbitHome = { yaw: -27, tilt: 36, zoom: 1, x: 0, y: 0 }
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

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

export function PointCloud({ points, pointColors, heading, hazards, phone, colorLabel, overlayPoints, people, imageAspect = 4 / 3, cameraOverlay, denseScan, depthPreview, fillRecent, modelMasks }: {
  points: readonly DepthPoint[] | undefined
  pointColors?: string
  heading: Heading | null
  hazards?: readonly Hazard[]
  phone: boolean
  colorLabel?: string
  overlayPoints?: readonly { point: DepthPoint; rgb: number }[]
  people?: ModelPreview['people']
  imageAspect?: number
  cameraOverlay?: { coordinates?: string; content: ReactNode; upright?: ReactNode }
  denseScan?: DenseScan
  depthPreview?: DepthPreview
  fillRecent?: boolean
  modelMasks?: ModelPreview['masks']
}) {
  const [camera, setCamera] = useState(orbitHome)
  const trailClip = useId()
  const [angled, setAngled] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [depthColor, setDepthColor] = useState(false)
  const [panMode, setPanMode] = useState(false)
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ id: number; x: number; y: number; pan: boolean } | null>(null)
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
  useEffect(() => {
    const element = scan.current
    if (!orbit || !element) return
    function wheel(event: WheelEvent) {
      event.preventDefault()
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1)
      setCamera(current => ({ ...current, zoom: clamp(current.zoom * Math.exp(-delta * 0.0018), 0.25, 6) }))
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [orbit])

  function moveCamera(dx: number, dy: number, pan: boolean, height: number) {
    setCamera(current => pan
      ? { ...current, x: current.x + dx * 420 / height, y: current.y + dy * 420 / height }
      : { ...current, yaw: ((current.yaw + dx * 0.4 + 180) % 360 + 360) % 360 - 180,
        tilt: clamp(current.tilt + dy * 0.4, -89, 89) })
  }

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if (!orbit || drag.current || ![0, 1, 2].includes(event.button)) return
    event.preventDefault()
    event.currentTarget.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, pan: panMode || event.shiftKey || event.button !== 0 }
    setDragging(true)
  }

  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    const previous = drag.current
    if (previous?.id !== event.pointerId) return
    const dx = event.clientX - previous.x
    moveCamera(previous.pan ? dx : -dx, event.clientY - previous.y, previous.pan, Math.max(1, event.currentTarget.clientHeight))
    previous.x = event.clientX
    previous.y = event.clientY
  }

  function stopDrag(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.id !== event.pointerId) return
    drag.current = null
    setDragging(false)
  }
  const imageCoordinates = useMemo(() => cameraOverlay?.coordinates ? atob(cameraOverlay.coordinates) : '', [cameraOverlay?.coordinates])
  const [gapFill, setGapFill] = useState(true)
  const [history, setHistory] = useState<ScanFrame[]>([])
  const currentDense = useMemo(() => denseScan ? decodeDenseScan(denseScan) : undefined, [denseScan?.timeMs, denseScan?.samples])
  const trackedScan = fillRecent && gapFill && denseScan?.tracking ? denseScan : undefined
  useEffect(() => {
    setHistory(previous => {
      if (!trackedScan || !currentDense) return previous.length ? [] : previous
      const session = trackedScan.tracking?.session
      if (previous[0]?.scan.timeMs === trackedScan.timeMs && previous[0]?.scan.tracking?.session === session) return previous
      return [{ scan: trackedScan, decoded: currentDense }, ...previous.filter(({ scan }) =>
        scan.tracking?.session === session && scan.timeMs < trackedScan.timeMs &&
        trackedScan.timeMs - scan.timeMs <= SCAN_HISTORY_MS).slice(0, 4)]
    })
  }, [trackedScan, currentDense])
  const fused = useMemo(() => trackedScan && currentDense
    ? fillScanGaps({ scan: trackedScan, decoded: currentDense }, history) : undefined, [trackedScan, currentDense, history])
  const dense = fused ?? currentDense
  // Semantic labels belong only to measured points from this exact frame.
  const semanticColors = useMemo(() => orbit && denseScan && currentDense && modelMasks
    ? modelPointColors(denseScan, currentDense.indices, modelMasks) : undefined,
  [orbit, denseScan, currentDense, modelMasks])
  const visiblePoints = dense?.points ?? points
  const showCameraOverlay = !orbit && (!!dense || !!imageCoordinates)
  const hasCameraColor = dense ? !!dense.colors.length : !!rgb?.length
  const showDepthColor = depthColor && !!dense
  const frontDepth = !orbit && showDepthColor ? denseScan : undefined
  const depthPixels = useMemo(() => frontDepth ? renderDepthRaster(frontDepth, depthPreview, depthPalette) : undefined,
    [frontDepth, depthPreview])
  const scale = 58 * camera.zoom * (phone ? 1.6 : 1)
  const centerDepth = phone ? 1.75 : 2.5
  const bounds = useMemo(() => frontBounds(dense ? undefined : points), [dense, points])
  const frontScale = zoom * Math.min(frameWidth * 0.94 / Math.max(0.15, bounds.right - bounds.left),
    420 * 0.90 / Math.max(0.15, bounds.top - bounds.bottom), 900)
  const frontX = (bounds.left + bounds.right) / 2
  const frontY = (bounds.bottom + bounds.top) / 2
  const centerX = frameWidth / 2
  const viewBox = `0 0 ${frameWidth} 420`
  const rotation = scanDisplayRotation(denseScan)
  const sensorAspect = denseScan ? denseScan.width / denseScan.height : imageAspect
  const aspect = depthPixels ? depthPixels.width / depthPixels.height : Math.abs(rotation) === 90 ? 1 / sensorAspect : sensorAspect
  const imageWidth = Math.min(frameWidth, 420 * aspect) * zoom
  const imageHeight = imageWidth / aspect
  const imageX = (frameWidth - imageWidth) / 2
  const imageY = (420 - imageHeight) / 2
  function projectImage(u: number, v: number): [number, number] {
    const [x, y] = orientImagePoint(u, v, rotation)
    return [imageX + x * imageWidth, imageY + y * imageHeight]
  }
  const angle = camera.yaw * Math.PI / 180
  const pitch = camera.tilt * Math.PI / 180
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
    return [centerX + camera.x + (right * cos + (forward - centerDepth) * sin) * scale,
      210 + camera.y - (up * pitchCos + depth * pitchSin) * scale, depth * pitchCos - up * pitchSin]
  }
  const project = (point: DepthPoint) => projectPoint(point).slice(0, 2)
  const grid = Array.from({ length: 11 }, (_, i) => {
    const x = i - 5
    const depth = i / 2
    return [`M${project([x, -1.2, 0])}L${project([x, -1.2, 5])}`,
      `M${project([-5, -1.2, depth])}L${project([5, -1.2, depth])}`].join('')
  }).join('')
  const layers = new Map<string, string>()
  const vertexData = new Float32Array(depthPixels ? 0 : ((visiblePoints?.length ?? 0) + (overlayPoints?.length ?? 0)) * 6)
  let offset = 0
  function addPoint(point: DepthPoint, pointRgb: number | undefined, overlay = false, index?: number) {
    if (!orbit && !showCameraOverlay && point[2] < 0.08) return
    let [x, y, depth] = projectPoint(point)
    if (showCameraOverlay && index !== undefined && dense && denseScan) {
      const pixel = dense.indices[index]
      const position = projectImage((pixel % denseScan.width + 0.5) / denseScan.width,
        (Math.floor(pixel / denseScan.width) + 0.5) / denseScan.height)
      x = position[0]
      y = position[1]
      depth = dense.depths[index]
    } else if (showCameraOverlay && index !== undefined) {
      const offset = index * 4
      const u = imageCoordinates.charCodeAt(offset) | (imageCoordinates.charCodeAt(offset + 1) << 8)
      const v = imageCoordinates.charCodeAt(offset + 2) | (imageCoordinates.charCodeAt(offset + 3) << 8)
      x = imageX + u / 65_535 * imageWidth
      y = imageY + v / 65_535 * imageHeight
    }
    const layer = point[1] < -0.95 ? 0 : point[1] < -0.45 ? 1 : point[1] < 0.2 ? 2 : 3
    const color = pointRgb ?? heightRgb[layer]
    vertexData[offset++] = x / centerX - 1
    vertexData[offset++] = 1 - y / 210
    vertexData[offset++] = depth / (1 + Math.abs(depth)) - (overlay ? 0.002 : 0)
    vertexData[offset++] = (color >> 16) / 255
    vertexData[offset++] = ((color >> 8) & 255) / 255
    vertexData[offset++] = (color & 255) / 255
    if (fallback) {
      const stroke = `#${color.toString(16).padStart(6, '0')}`
      layers.set(stroke, (layers.get(stroke) ?? '') + `M${x.toFixed(1)},${y.toFixed(1)}h2.1`)
    }
  }
  if (!depthPixels) {
    visiblePoints?.forEach((point, index) => {
      const baseColor = dense
        ? showDepthColor ? depthRgb[clamp(Math.round(dense.depths[index] * 100), 1, 500)] : dense.colors[index]
        : rgb?.[index]
      addPoint(point, semanticColors?.[index] ?? baseColor, false, index)
    })
    if (!showCameraOverlay && !semanticColors) overlayPoints?.forEach(({ point, rgb }) => addPoint(point, rgb, true))
  }
  const direction = (heading ?? 0) * Math.PI / 180
  const origin = project([0, -1.2, 0])
  const axes = [
    { label: 'X', end: project([0.65, -1.2, 0]), color: '#e5a288' },
    { label: 'Y', end: project([0, -0.55, 0]), color: '#a1b979' },
    { label: 'Z', end: project([0, -1.2, 0.65]), color: '#9dd9e8' },
  ]
  return <>
    <div className="scan" ref={scan} data-orbit={orbit} data-dragging={dragging}
      tabIndex={orbit ? 0 : undefined}
      aria-label={orbit ? 'Orbit viewport. Arrow keys rotate, Shift plus arrow keys pan.' : undefined}
      onPointerDown={startDrag} onPointerMove={moveDrag} onLostPointerCapture={stopDrag}
      onContextMenu={orbit ? event => event.preventDefault() : undefined}
      onKeyDown={event => {
        if (!orbit) return
        const dx = event.key === 'ArrowLeft' ? -16 : event.key === 'ArrowRight' ? 16 : 0
        const dy = event.key === 'ArrowUp' ? -16 : event.key === 'ArrowDown' ? 16 : 0
        if (!dx && !dy) return
        event.preventDefault()
        moveCamera(dx, dy, event.shiftKey, Math.max(1, event.currentTarget.clientHeight))
      }}>
      {orbit && <svg viewBox={viewBox} className="cloud" aria-hidden="true">
        <path d={grid} fill="none" stroke="#293039" />
      </svg>}
      {!depthPixels && <CloudCanvas vertices={vertexData.subarray(0, offset)} frameWidth={frameWidth} onFallback={setFallback} />}
      <svg viewBox={viewBox} className="cloud" role="img"
        aria-label={depthPixels ? 'LiDAR depth map' : showDepthColor ? '3D LiDAR points colored by depth' : colorLabel ?? (hasCameraColor ? '3D LiDAR points with camera colors' : '3D LiDAR points colored by relative height')}>
        {depthPixels && <foreignObject x={imageX} y={imageY} width={imageWidth} height={imageHeight}>
          <DepthRaster pixels={depthPixels} />
        </foreignObject>}
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
        {showCameraOverlay && cameraOverlay && <svg x={imageX} y={imageY} width={imageWidth} height={imageHeight}
          viewBox="0 0 96 96" preserveAspectRatio="none">
          <g transform={`rotate(${rotation} 48 48)`}>{cameraOverlay.content}</g>
          {cameraOverlay.upright}
        </svg>}
        {showCameraOverlay && denseScan && people?.length ? <defs><clipPath id={trailClip}>
          <rect x={imageX} y={imageY} width={imageWidth} height={imageHeight} />
        </clipPath></defs> : null}
        {people?.map(({ position, predictedPosition, box, confidence, trackId, history, trajectory }, index) => {
          if (!position || (!showCameraOverlay && position[2] < 0.08)) return null
          const [right, up, forward] = position
          // Estimate a box on the plane of the observed return using the image box size.
          const halfWidth = box[2] * forward * 0.7
          const halfHeight = box[3] * forward * 0.7 / imageAspect
          const corners: DepthPoint[] = [
            [right - halfWidth, up + halfHeight, forward], [right + halfWidth, up + halfHeight, forward],
            [right + halfWidth, up - halfHeight, forward], [right - halfWidth, up - halfHeight, forward],
          ]
          const [x, y] = project(corners[0])
          const projectTrail = (point: DepthPoint) => {
            if (showCameraOverlay && denseScan) {
              const uv = scanImagePoint(denseScan, point)
              return uv ? projectImage(...uv) : undefined
            }
            return orbit || point[2] >= 0.08 ? project(point) : undefined
          }
          const trail = (points: readonly DepthPoint[]) => {
            const projected = points.map(projectTrail)
            return projected.every(point => point !== undefined) ? projected.join(' ') : undefined
          }
          const future = trajectory?.length ? [position, ...trajectory] : predictedPosition ? [position, predictedPosition] : []
          return <g key={trackId === undefined ? `box-${index}` : `track-${trackId}`}
            clipPath={showCameraOverlay && denseScan ? `url(#${trailClip})` : undefined}>
            {!showCameraOverlay && <>
              <polygon points={corners.map(project).join(' ')} fill="none" stroke="var(--model-person)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
              <text x={x + 3} y={y - 4} fill="var(--model-person)" fontSize="12">Person {trackId === undefined ? '' : `#${trackId} `}{Math.round(confidence * 100)}%</text>
            </>}
            {history && history.length > 1 && <polyline points={trail(history)}
              fill="none" stroke="var(--model-person)" strokeWidth="2" opacity=".65" />}
            {future.length > 1 && <polyline points={trail(future)}
              fill="none" stroke="#ffc373" strokeWidth="2" strokeDasharray="5 4" />}
          </g>
        })}
      </svg>
      <div className="scan-label">{phone ? 'ARKIT' : 'SIM'} / {visiblePoints?.length.toLocaleString() ?? 0} points
        {fused?.filled ? ` / ${fused.filled.toLocaleString()} from recent frames` : ''}
        {fallback && !depthPixels ? ' / SVG fallback' : ''}</div>
      {!visiblePoints?.length && !hazards?.length && <p className="scan-empty">{!phone || visiblePoints ? 'No depth returns' : 'Enable 3D scan sharing on the iPhone'}</p>}
    </div>
    <div className="legend">
      {showDepthColor ? <span className="depth-key">Near <i className="depth-scale" />{DEFAULT_DEPTH_RANGE_M} m</span>
        : colorLabel ? <span>{colorLabel}</span> : hasCameraColor ? <span>Camera color</span>
        : <span><i className="height-scale" />Height relative to phone</span>}
      <div className="scan-modes">
        <button aria-pressed={!angled} onClick={() => setAngled(false)}>Front</button>
        <button aria-pressed={angled} onClick={() => setAngled(true)}>Orbit</button>
        {fillRecent && denseScan?.tracking && <button aria-pressed={gapFill} onClick={() => setGapFill(value => !value)}>Fill gaps</button>}
      </div>
      {dense && <div className="scan-modes" role="group" aria-label="Point colors">
        <button aria-pressed={!showDepthColor} onClick={() => setDepthColor(false)}>{hasCameraColor ? 'RGB' : 'Height'}</button>
        <button aria-pressed={showDepthColor} onClick={() => setDepthColor(true)}>Depth</button>
      </div>}
      <label className="orbit">Zoom <input type="range" min={orbit ? 0.25 : 0.6} max={orbit ? 6 : 2.5} step="0.05" value={orbit ? camera.zoom : zoom}
        onChange={event => {
          const zoom = Number(event.target.value)
          if (orbit) setCamera(current => ({ ...current, zoom }))
          else setZoom(zoom)
        }} /></label>
      {orbit && <>
        <label className="orbit">Rotate <input type="range" min="-180" max="180" value={camera.yaw}
          onChange={event => { const yaw = Number(event.target.value); setCamera(current => ({ ...current, yaw })) }} /></label>
        <label className="orbit">Tilt <input type="range" min="-89" max="89" value={camera.tilt}
          onChange={event => { const tilt = Number(event.target.value); setCamera(current => ({ ...current, tilt })) }} /></label>
        <div className="scan-modes">
          <button aria-pressed={panMode} title="Drag to pan. You can also Shift-drag or use the middle mouse button."
            onClick={() => setPanMode(value => !value)}>Pan</button>
          <button onClick={() => { setCamera(orbitHome); setPanMode(false) }}>Reset view</button>
        </div>
      </>}
    </div>
  </>
}
