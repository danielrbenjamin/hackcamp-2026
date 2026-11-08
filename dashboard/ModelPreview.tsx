import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { ModelPreview as Preview } from '../shared/contracts'
import { PointCloud } from './PointCloud'
import { glassBearing } from './modelColors'
import { estimateGlassRange } from './glassRange'
import { distancePalette } from './DepthImages'
import { orientImagePoint, scanDisplayRotation } from './denseScan'

const glass = [84, 203, 237]
const riser = [248, 166, 96]
const tread = [251, 215, 123]
const personColor = 'var(--model-person)'
const depthColors = distancePalette(300)
const mutedDepthColors = depthColors.map((_, cm) => {
  const light = cm > 0 ? 0.2 + 0.8 * Math.max(0, 1 - cm / 300) : 0
  return [10 + light * 47, 16 + light * 77, 24 + light * 99, 255]
})

function SceneImage({ depth, muted }: { depth: NonNullable<Preview['depthPreview']>; muted: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const { width, height } = depth
  useEffect(() => {
    const context = canvas.current?.getContext('2d')
    if (!context) return
    const pixels = context.createImageData(width, height)
    const samples = atob(depth.samples)
    const colors = muted ? mutedDepthColors : depthColors
    for (let i = 0; i < width * height; i++) {
      const cm = (samples.charCodeAt(i * 2) | (samples.charCodeAt(i * 2 + 1) << 8)) & 0x3fff
      pixels.data.set(colors[Math.min(cm, 500)], i * 4)
    }
    context.putImageData(pixels, 0, 0)
  }, [depth, width, height, muted])
  return <canvas ref={canvas} width={width} height={height} role="img" aria-label="Depth image from the model frame" />
}

function PersonBoxes({ people, width, height, rotation = 0 }: {
  people: Preview['people']; width: number; height: number; rotation?: ReturnType<typeof scanDisplayRotation>
}) {
  return <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="Person boxes in camera image coordinates">
    {people.map(({ box: [u, v, w, h], confidence }, index) => {
      const [x1, y1] = orientImagePoint(u, v, rotation)
      const [x2, y2] = orientImagePoint(u + w, v + h, rotation)
      const x = Math.min(x1, x2), y = Math.min(y1, y2)
      const font = height * 0.045
      const label = `Person ${Math.round(confidence * 100)}%`
      const labelWidth = font * (label.length * 0.62 + 0.8)
      const labelX = Math.max(0, Math.min(x * width, width - labelWidth))
      const labelY = Math.max(0, y * height - font * 1.45)
      return <g key={index}>
        <rect x={x * width} y={y * height} width={Math.abs(x2 - x1) * width} height={Math.abs(y2 - y1) * height} fill={personColor} fillOpacity=".06" stroke={personColor} strokeWidth="2" vectorEffect="non-scaling-stroke" />
        <rect x={labelX} y={labelY} width={labelWidth} height={font * 1.45} fill={personColor} />
        <text x={labelX + font * 0.4} y={labelY + font} fill="#0a1610" fontSize={font} fontWeight="700">{label}</text>
      </g>
    })}
  </svg>
}

function ScanMasks({ masks }: { masks: Preview['masks'] }) {
  const layers = useMemo(() => masks.flatMap(mask => {
    const labels = atob(mask.labels)
    const paths = ['', '', '']
    const edges = ['', '', '']
    for (let y = 0; y < mask.size; y++) {
      for (let x = 0; x < mask.size;) {
        const label = labels.charCodeAt(y * mask.size + x)
        let end = x + 1
        while (end < mask.size && labels.charCodeAt(y * mask.size + end) === label) end++
        if (label === 1 || label === 2) {
          paths[label] += `M${x},${y}h${end - x}v1H${x}z`
          edges[label] += `M${x},${y}v1M${end},${y}v1`
          for (let col = x; col < end; col++) {
            if (labels.charCodeAt((y - 1) * mask.size + col) !== label) edges[label] += `M${col},${y}h1`
            if (labels.charCodeAt((y + 1) * mask.size + col) !== label) edges[label] += `M${col},${y + 1}h1`
          }
        }
        x = end
      }
    }
    return paths.slice(1).map((path, index) => ({
      key: `${mask.kind}-${index}`, path, edge: edges[index + 1], size: mask.size,
      color: mask.kind === 'glass' ? glass : index === 0 ? riser : tread,
    }))
  }), [masks])
  return layers.filter(layer => layer.path).map(({ key, path, edge, size, color }) => {
    const tint = `rgb(${color.join(',')})`
    return <g key={key} transform={`scale(${96 / size})`}>
      <path d={path} fill={tint} fillOpacity={0.4} />
      <path d={edge} fill="none" stroke={tint} strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
    </g>
  })
}

function ModelKey({ kind }: { kind?: 'glass' | 'stairs' | 'person' }) {
  return <div className="model-key">
    {(!kind || kind === 'glass') && <span><i style={{ background: `rgb(${glass.join(',')})` }} />Glass</span>}
    {(!kind || kind === 'stairs') && <>
      <span><i style={{ background: `rgb(${riser.join(',')})` }} />Stair riser</span>
      <span><i style={{ background: `rgb(${tread.join(',')})` }} />Stair tread</span>
    </>}
    {(!kind || kind === 'person') && <span><i style={{ background: personColor }} />Person</span>}
  </div>
}

export const ModelPreview = memo(function ModelPreview({ preview, view, mutedDepth, setMutedDepth }: {
  preview?: Preview
  view: 'separate' | 'combined' | 'scan'
  mutedDepth: boolean
  setMutedDepth: (value: boolean) => void
}) {
  const overlays = useMemo(() => preview?.masks.flatMap(mask => {
      const [red, green, blue] = mask.kind === 'glass' ? glass : riser
      return mask.points.map(point => ({ point, rgb: (red << 16) | (green << 8) | blue }))
    }) ?? [], [preview])
  const matchingScan = preview?.denseScan?.timeMs === preview?.timeMs ? preview?.denseScan : undefined
  const masks = preview?.masks
  const glassReading = useMemo(() => matchingScan && masks ? {
    timeMs: matchingScan.timeMs,
    session: matchingScan.tracking?.session,
    bearing: glassBearing(matchingScan, masks),
    range: estimateGlassRange(matchingScan, masks),
  } : undefined, [matchingScan, masks])
  const previousGlassReading = useRef<typeof glassReading>(undefined)
  const [confirmedGlassTime, setConfirmedGlassTime] = useState<number>()
  useEffect(() => {
    if (preview?.partial && !glassReading?.bearing) return
    const previous = previousGlassReading.current
    if (glassReading && previous?.timeMs === glassReading.timeMs) return
    previousGlassReading.current = glassReading
    if (previous?.range === undefined || glassReading?.range === undefined ||
        !previous.bearing || !glassReading.bearing || previous.session !== glassReading.session) return
    const elapsed = glassReading.timeMs - previous.timeMs
    if (elapsed > 0 && elapsed <= 8000 &&
        Math.abs(glassReading.range - previous.range) <= 0.2 &&
        Math.abs(glassReading.bearing.left - previous.bearing.left) <= 8 &&
        Math.abs(glassReading.bearing.right - previous.bearing.right) <= 8) {
      setConfirmedGlassTime(glassReading.timeMs)
    }
  }, [glassReading, preview?.partial])
  if (!preview) return <p className="waiting">On iPhone, enable Preview hazard models and Share 3D scan with dashboard.</p>

  const depth = preview.depthPreview
  const width = depth?.width ?? preview.denseScan?.width ?? 128
  const height = depth?.height ?? preview.denseScan?.height ?? 96
  const rotation = scanDisplayRotation(preview.denseScan)
  const portrait = Math.abs(rotation) === 90
  const alignedScan = !!preview.denseScan || !!preview.scan?.imageCoordinates
  const bearing = glassReading?.bearing
  const glassRange = glassReading?.timeMs === confirmedGlassTime ? glassReading?.range : undefined
  const unlocated = preview.people.filter(person => !person.position || person.position[2] < 0.08).length
  return <>
    <div className="model-preview-toolbar">
      {view !== 'scan' && depth && <div className="scan-modes" role="group" aria-label="Depth palette">
        <button aria-pressed={!mutedDepth} onClick={() => setMutedDepth(false)}>Color</button>
        <button aria-pressed={mutedDepth} onClick={() => setMutedDepth(true)}>Muted blue</button>
      </div>}
      {bearing && <span>Glass bearing {bearing.left.toFixed(0)}° to {bearing.right.toFixed(0)}° · {glassRange === undefined ? 'Distance unknown' : `Estimated glass distance ~${glassRange.toFixed(1)} m`}</span>}
      <span className="model-latency">{Math.round(preview.latencyMs)} ms{preview.partial ? ' · Partial results' : ''}</span>
    </div>
    {view === 'scan' ? (preview.scan || preview.denseScan) ? <>
      <PointCloud points={preview.scan?.points} pointColors={preview.scan?.pointColors} denseScan={preview.denseScan} overlayPoints={overlays}
        modelMasks={matchingScan ? preview.masks : undefined}
        people={preview.people} imageAspect={depth ? width / height : undefined} heading={null} phone
        cameraOverlay={alignedScan ? {
          coordinates: preview.scan?.imageCoordinates,
          content: <ScanMasks masks={preview.masks} />,
          upright: <svg width={96} height={96}>
            <PersonBoxes people={preview.people} width={portrait ? height : width} height={portrait ? width : height} rotation={rotation} />
          </svg>,
        } : undefined}
        colorLabel={(preview.denseScan?.cameraColor || preview.scan?.pointColors) ? 'Camera color with model detections' : 'Height colors with model detections'} />
      <div className="legend">
        <ModelKey />
        {alignedScan && <span>Front shows full masks and boxes. Orbit labels measured depth returns.</span>}
        {bearing && <span>Depth inside a glass mask can come from behind the glass.</span>}
        {preview.people.some(person => person.history || person.trajectory) &&
          <span>Solid trails show measured motion. Dashed trails show the 0.6-second forecast.</span>}
        {!alignedScan && <span>Rebuild Lantern for aligned masks and boxes in Front view.</span>}
        {unlocated > 0 && <span>{unlocated} person {unlocated === 1 ? 'box is' : 'boxes are'} available only in 2D.</span>}
      </div>
    </> : <p className="waiting">No 3D scan arrived with this model frame. Check scan sharing and the installed iPhone build.</p>
      : view === 'combined' ? <div className="model-images model-combined">
      <figure>
        <figcaption>{depth ? 'Depth with detections' : 'Detections'}<span>{preview.people.length} {preview.people.length === 1 ? 'person' : 'people'}</span></figcaption>
        <div className="model-scene" style={{ aspectRatio: width / height }}>
          {depth && <SceneImage depth={depth} muted={mutedDepth} />}
          <svg viewBox="0 0 96 96" preserveAspectRatio="none" role="img" aria-label="Glass and stair segmentation masks"><ScanMasks masks={preview.masks} /></svg>
          <PersonBoxes people={preview.people} width={width} height={height} />
        </div>
        <ModelKey />
      </figure>
    </div> : <div className="model-images">
      {(['glass', 'stairs'] as const).map(kind => {
        const mask = preview.masks.find(item => item.kind === kind)
        const hasDetection = mask && /[^\x00]/.test(atob(mask.labels))
        return <figure key={kind}>
          <figcaption>{kind === 'glass' ? 'Glass' : 'Stairs'}<span>{mask ? hasDetection ? 'Detected' : 'No detection' : 'No mask'}</span></figcaption>
          <div className="model-scene" style={{ aspectRatio: width / height }}>
            {depth && <SceneImage depth={depth} muted={mutedDepth} />}
            {mask && <svg viewBox="0 0 96 96" preserveAspectRatio="none" role="img" aria-label={`${kind} segmentation mask`}><ScanMasks masks={[mask]} /></svg>}
          </div>
          <span>{preview.models[kind]}</span>
          <ModelKey kind={kind} />
        </figure>
      })}
      <figure>
        <figcaption>People<span>{preview.people.length} detected</span></figcaption>
        <div className="model-scene" style={{ aspectRatio: width / height }}>
        {depth && <SceneImage depth={depth} muted={mutedDepth} />}
        <PersonBoxes people={preview.people} width={width} height={height} />
        </div>
        <span>{preview.models.person}</span>
        <ModelKey kind="person" />
      </figure>
    </div>}
  </>
}, (previous, next) => {
  if (previous.view !== next.view || previous.mutedDepth !== next.mutedDepth ||
      previous.setMutedDepth !== next.setMutedDepth) return false
  const before = previous.preview
  const after = next.preview
  if (before === after) return true
  // The relay repeats snapshots while live guidance continues to update.
  return !!before && !!after && before.timeMs === after.timeMs && before.latencyMs === after.latencyMs &&
    before.partial === after.partial && !!before.denseScan === !!after.denseScan &&
    !!before.scan === !!after.scan && !!before.depthPreview === !!after.depthPreview
})
