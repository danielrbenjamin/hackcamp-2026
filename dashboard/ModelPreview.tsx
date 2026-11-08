import { memo, useEffect, useMemo, useRef } from 'react'
import type { ModelPreview as Preview } from '../shared/contracts'
import { PointCloud } from './PointCloud'
import { glassBearing } from './modelColors'
import { distancePalette } from './DepthImages'
import { denseScanData, orientImagePoint, scanDisplayRotation } from './denseScan'

const glass = [84, 203, 237]
const riser = [248, 166, 96]
const tread = [251, 215, 123]
const personColor = 'var(--model-person)'
const depthColors = distancePalette(300)
const timingLabels = {
  scan: 'Scan prep', person: 'People', glassInput: 'Glass input', glassInference: 'Glass model',
  glassMask: 'Glass mask', stairsInput: 'Stairs input', stairsInference: 'Stairs model', stairsMask: 'Stairs mask',
} as const

function stageTimings(preview: Preview) {
  return (Object.keys(timingLabels) as (keyof typeof timingLabels)[]).flatMap(key => {
    const ms = preview.stageMs?.[key]
    return typeof ms === 'number' && Number.isFinite(ms) ? [`${timingLabels[key]} ${Math.round(ms)} ms`] : []
  }).join(' · ')
}
const mutedDepthColors = depthColors.map((_, cm) => {
  const light = cm > 0 ? 0.2 + 0.8 * Math.max(0, 1 - cm / 300) : 0
  return [10 + light * 47, 16 + light * 77, 24 + light * 99, 255]
})

function modelScene(frame: Preview) {
  const scan = frame.denseScan?.timeMs === frame.timeMs ? frame.denseScan : undefined
  const depth = frame.depthPreview
  const width = scan?.width ?? depth?.width ?? 128
  const height = scan?.height ?? depth?.height ?? 96
  return { scan, depth, width, height }
}

function renderSceneImage(scene: ReturnType<typeof modelScene>, muted: boolean) {
  const { scan, depth, width, height } = scene
  if (!scan && !depth) return undefined
  const pixels = new ImageData(width, height)
  const raster = scan ? denseScanData(scan) : undefined
  const samples = !raster && depth ? atob(depth.samples) : ''
  const colors = muted ? mutedDepthColors : depthColors
  for (let i = 0; i < width * height; i++) {
    const meters = raster?.getFloat32(i * 8, true)
    const cm = meters === undefined
      ? (samples.charCodeAt(i * 2) | (samples.charCodeAt(i * 2 + 1) << 8)) & 0x3fff
      : Number.isFinite(meters) && meters > 0 ? Math.max(1, Math.round(meters * 100)) : 0
    pixels.data.set(colors[Math.min(cm, 500)], i * 4)
  }
  return pixels
}

function SceneImage({ pixels }: { pixels: ImageData }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    canvas.current?.getContext('2d')?.putImageData(pixels, 0, 0)
  }, [pixels])
  return <canvas ref={canvas} width={pixels.width} height={pixels.height} role="img" aria-label="Depth image from the model frame" />
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
  const bearing = useMemo(() => matchingScan && masks ? glassBearing(matchingScan, masks) : undefined, [matchingScan, masks])
  const scene = useMemo(() => preview ? modelScene(preview) : undefined, [preview])
  const pixels = useMemo(() => view !== 'scan' && scene ? renderSceneImage(scene, mutedDepth) : undefined, [scene, mutedDepth, view])
  if (!preview || !scene) return <p className="waiting">On iPhone, enable Preview hazard models and Share 3D scan with dashboard.</p>

  const { width, height } = scene
  const rotation = view === 'scan' ? scanDisplayRotation(scene.scan) : 0
  const sideways = Math.abs(rotation) === 90
  const hasDepth = !!(scene.scan || scene.depth)
  const alignedScan = !!preview.denseScan || !!preview.scan?.imageCoordinates
  const unlocated = preview.people.filter(person => !person.position || person.position[2] < 0.08).length
  const timings = stageTimings(preview)
  return <>
    <div className="model-preview-toolbar">
      {view !== 'scan' && hasDepth && <div className="scan-modes" role="group" aria-label="Depth palette">
        <button aria-pressed={!mutedDepth} onClick={() => setMutedDepth(false)}>Color</button>
        <button aria-pressed={mutedDepth} onClick={() => setMutedDepth(true)}>Muted blue</button>
      </div>}
      {bearing && <span>Glass bearing {bearing.left.toFixed(0)}° to {bearing.right.toFixed(0)}°</span>}
      {preview.rotationDegrees !== undefined && <span>
        Model input rotation {preview.rotationDegrees}°{matchingScan && preview.rotationDegrees !== rotation ? ` · Display rotation ${rotation}°` : ''}
      </span>}
      <span className="model-latency">{Math.round(preview.latencyMs)} ms{preview.partial ? ' · Partial results' : ''}</span>
      {timings && <details>
        <summary>Timings</summary>
        <div>{timings}</div>
      </details>}
    </div>
    {view === 'scan' ? (preview.scan || preview.denseScan) ? <>
      <PointCloud points={preview.scan?.points} pointColors={preview.scan?.pointColors} denseScan={preview.denseScan} overlayPoints={overlays}
        modelMasks={matchingScan ? preview.masks : undefined}
        people={preview.people} imageAspect={scene.depth ? scene.depth.width / scene.depth.height : undefined} heading={null} phone
        cameraOverlay={alignedScan ? {
          coordinates: preview.scan?.imageCoordinates,
          content: <ScanMasks masks={preview.masks} />,
          upright: <svg width={96} height={96}>
            <PersonBoxes people={preview.people} width={sideways ? height : width} height={sideways ? width : height} rotation={rotation} />
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
    </> : <p className="waiting">Waiting for a model frame with a 3D scan. On iPhone, turn on Share 3D scan with dashboard.</p>
      : view === 'combined' ? <div className="model-images model-combined">
      <figure>
        <figcaption>{hasDepth ? 'Depth with detections' : 'Detections'}<span>{preview.people.length} {preview.people.length === 1 ? 'person' : 'people'}</span></figcaption>
        <div className="model-scene" style={{ aspectRatio: width / height }}>
          {pixels && <SceneImage pixels={pixels} />}
          <svg viewBox="0 0 96 96" preserveAspectRatio="none" role="img" aria-label="Glass and stair segmentation masks">
            <ScanMasks masks={preview.masks} />
          </svg>
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
            {pixels && <SceneImage pixels={pixels} />}
            {mask && <svg viewBox="0 0 96 96" preserveAspectRatio="none" role="img" aria-label={`${kind} segmentation mask`}>
              <ScanMasks masks={[mask]} />
            </svg>}
          </div>
          <span>{preview.models[kind]}</span>
          <ModelKey kind={kind} />
        </figure>
      })}
      <figure>
        <figcaption>People<span>{preview.people.length} detected</span></figcaption>
        <div className="model-scene" style={{ aspectRatio: width / height }}>
        {pixels && <SceneImage pixels={pixels} />}
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
