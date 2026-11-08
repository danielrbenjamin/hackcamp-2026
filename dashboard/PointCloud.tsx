import { useEffect, useMemo, useRef, useState } from 'react'
import { HAZARD_LABELS, type DepthPoint, type Grid, type Hazard, type Heading, type ScanPose } from '../shared/contracts'
import { addScanFrame, type ScanPoint } from '../shared/roomScan'

const colors = ['#49608b', '#59a8b2', '#a1b979', '#e9ae6b']

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

export function PointCloud({ points, pointColors, heading, hazards, phone, scanPose, timeMs }: {
  points: readonly DepthPoint[] | undefined
  pointColors?: string
  heading: Heading | null
  hazards?: readonly Hazard[]
  phone: boolean
  scanPose?: ScanPose
  timeMs: number
}) {
  const [yaw, setYaw] = useState(-27)
  const [tilt, setTilt] = useState(36)
  const [angled, setAngled] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [room, setRoom] = useState(false)
  const [roomPoints, setRoomPoints] = useState<ScanPoint[]>([])
  const roomScan = useRef({ session: '', timeMs: -Infinity, voxels: new Map<string, ScanPoint>() })
  const rgb = useMemo(() => {
    if (!pointColors) return undefined
    const bytes = atob(pointColors)
    return Array.from({ length: bytes.length / 3 }, (_, index) => {
      const start = index * 3
      return bytes.charCodeAt(start) * 65_536 + bytes.charCodeAt(start + 1) * 256 + bytes.charCodeAt(start + 2)
    })
  }, [pointColors])
  useEffect(() => {
    const scan = roomScan.current
    const session = phone && points !== undefined ? scanPose?.session ?? scan.session : ''
    if (scan.session !== session) {
      scan.session = session
      scan.timeMs = -Infinity
      scan.voxels.clear()
      setRoomPoints([])
    }
    if (!room || !scanPose || !points?.length || timeMs <= scan.timeMs) return
    scan.timeMs = timeMs
    addScanFrame(scan.voxels, points, scanPose, rgb)
    setRoomPoints([...scan.voxels.values()])
  }, [room, scanPose, points, phone, timeMs, rgb])
  const roomAvailable = phone && points !== undefined && (!!scanPose || roomPoints.length > 0)
  const showRoom = room && roomAvailable
  const orbit = showRoom || angled
  const visiblePoints: ScanPoint[] | undefined = showRoom ? roomPoints
    : points?.map((position, index) => ({ position, rgb: rgb?.[index] }))
  const hasCameraColor = visiblePoints?.some(point => point.rgb !== undefined)
  const scale = 58 * zoom * (phone && !showRoom ? 1.6 : 1)
  const centerDepth = showRoom ? 0 : phone ? 1.75 : 2.5
  const angle = (orbit ? yaw : 0) * Math.PI / 180
  const pitch = (orbit ? tilt : 0) * Math.PI / 180
  const sin = Math.sin(angle)
  const cos = Math.cos(angle)
  function project([right, up, forward]: DepthPoint) {
    return [360 + (right * cos + (forward - centerDepth) * sin) * scale,
      212 - (up * Math.cos(pitch) + ((forward - centerDepth) * cos - right * sin) * Math.sin(pitch)) * scale]
  }
  const grid = Array.from({ length: 11 }, (_, i) => {
    const x = i - 5
    const depth = showRoom ? x : i / 2
    return [`M${project([x, -1.2, showRoom ? -5 : 0])}L${project([x, -1.2, 5])}`,
      `M${project([-5, -1.2, depth])}L${project([5, -1.2, depth])}`].join('')
  }).join('')
  const layers = new Map<string, string>()
  for (const { position: point, rgb } of visiblePoints ?? []) {
    const [x, y] = project(point)
    const layer = point[1] < -0.95 ? 0 : point[1] < -0.45 ? 1 : point[1] < 0.2 ? 2 : 3
    const color = rgb === undefined ? colors[layer] : cameraColor(rgb)
    layers.set(color, (layers.get(color) ?? '') + `M${x.toFixed(1)},${y.toFixed(1)}h2.1`)
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
      <svg viewBox="0 0 720 420" className="cloud" role="img"
        aria-label={hasCameraColor ? '3D LiDAR points with camera colors' : '3D LiDAR points colored by relative height'}>
        {orbit && <path d={grid} fill="none" stroke="#293039" />}
        {[...layers].map(([color, path]) => <path key={color} d={path} fill="none" stroke={color} strokeWidth="2.1" />)}
        {orbit && axes.map(({ label, end, color }) => <g key={label}>
          <path d={`M${origin}L${end}`} stroke={color} />
          <text x={end[0] + 4} y={end[1] - 3} fill={color} fontSize="10">{label}</text>
        </g>)}
        {orbit && <circle cx={project([0, 0, 0])[0]} cy={project([0, 0, 0])[1]} r="4" fill="#c2f2ff" />}
        {orbit && !showRoom && heading !== null && <path d={`M${project([0, -1.18, 0])}L${project([Math.sin(direction) * 2, -1.18, Math.cos(direction) * 2])}`}
          stroke="#c2f2ff" strokeWidth="2" strokeDasharray="5 4" />}
        {!showRoom && hazards?.map((hazard, index) => {
          if (!('position' in hazard)) return null
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
      <div className="scan-label">{showRoom ? 'ROOM SCAN' : phone ? 'ARKIT' : 'SIM'} / {visiblePoints?.length ?? 0} points</div>
      {!visiblePoints?.length && <p className="scan-empty">{showRoom ? 'Pan slowly to scan the room' : !phone || points ? 'No depth returns' : 'Enable 3D scan sharing on the iPhone'}</p>}
    </div>
    <div className="legend">
      {hasCameraColor ? <span>Camera color</span>
        : <span><i className="height-scale" />{showRoom ? 'Height relative to scan origin' : 'Height relative to phone'}</span>}
      {roomAvailable && <div className="scan-modes">
        <button aria-pressed={!room} onClick={() => setRoom(false)}>Live</button>
        <button aria-pressed={room} onClick={() => setRoom(true)}>Room scan</button>
        {room && <button onClick={() => {
          roomScan.current.voxels.clear()
          setRoomPoints([])
        }}>Clear scan</button>}
      </div>}
      {!showRoom && <div className="scan-modes">
        <button aria-pressed={!angled} onClick={() => setAngled(false)}>Front</button>
        <button aria-pressed={angled} onClick={() => setAngled(true)}>Orbit</button>
      </div>}
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
