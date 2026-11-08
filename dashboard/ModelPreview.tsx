import { useEffect, useMemo, useRef, useState } from 'react'
import type { Hazard, ModelPreview as Preview } from '../shared/contracts'
import { PointCloud } from './PointCloud'
import { distancePalette } from './DepthImages'

const glass = [84, 203, 237]
const riser = [248, 166, 96]
const tread = [251, 215, 123]
const backdropColors = distancePalette(300)

function SceneImage({ masks = [], depth }: { masks?: Preview['masks']; depth?: Preview['depthPreview'] }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const width = depth?.width ?? masks[0]?.size ?? 96
  const height = depth?.height ?? masks[0]?.size ?? 96
  useEffect(() => {
    const context = canvas.current?.getContext('2d')
    if (!context) return
    const pixels = context.createImageData(width, height)
    const layers = masks.map(mask => ({ ...mask, decoded: atob(mask.labels) }))
    const samples = depth ? atob(depth.samples) : ''
    for (let i = 0; i < width * height; i++) {
      const cm = (samples.charCodeAt(i * 2) | (samples.charCodeAt(i * 2 + 1) << 8)) & 0x3fff
      const backdrop = backdropColors[Math.min(cm, 500)]
      const color = backdrop.slice(0, 3).map(channel => 12 + channel * 0.55)
      for (const mask of layers) {
        const x = Math.floor((i % width) * mask.size / width)
        const y = Math.floor(Math.floor(i / width) * mask.size / height)
        const label = mask.decoded.charCodeAt(y * mask.size + x)
        if (!label) continue
        const tint = mask.kind === 'glass' ? glass : label === 1 ? riser : tread
        for (let channel = 0; channel < 3; channel++) color[channel] = color[channel] * 0.35 + tint[channel] * 0.65
      }
      for (let channel = 0; channel < 3; channel++) {
        pixels.data[i * 4 + channel] = color[channel]
      }
      pixels.data[i * 4 + 3] = 255
    }
    context.putImageData(pixels, 0, 0)
  }, [depth, masks, width, height])
  return <canvas ref={canvas} width={width} height={height} role="img"
    aria-label={masks.length ? 'Depth scene with segmentation masks' : 'Depth scene'} />
}

function PersonBoxes({ people, width, height }: { people: Preview['people']; width: number; height: number }) {
  return <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Person boxes in camera image coordinates">
    {people.map(({ box: [x, y, w, h], confidence }, index) => <g key={index}>
      <rect x={x * width} y={y * height} width={w * width} height={h * height} fill="none" stroke="#a7edff" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      <text x={x * width + 2} y={Math.max(height * 0.07, y * height - 2)} fill="#a7edff" fontSize={height * 0.055}>{Math.round(confidence * 100)}%</text>
    </g>)}
  </svg>
}

export function ModelPreview({ preview }: { preview?: Preview }) {
  const [view, setView] = useState<'separate' | 'combined' | 'detections' | 'scan'>('separate')
  const spatial = view === 'detections' || view === 'scan'
  const geometry = useMemo(() => {
    const points = preview?.masks.flatMap(mask => mask.points) ?? []
    const rgb = preview?.masks.map(mask => String.fromCharCode(...(mask.kind === 'glass' ? glass : riser))
      .repeat(mask.points.length)).join('') ?? ''
    const people: Hazard[] = preview?.people.flatMap(person => person.position
      ? [{ kind: 'person', confidence: person.confidence, position: person.position, predictedPosition: person.predictedPosition }]
      : []) ?? []
    const overlays = preview?.masks.flatMap(mask => {
      const [red, green, blue] = mask.kind === 'glass' ? glass : riser
      return mask.points.map(point => ({ point, rgb: (red << 16) | (green << 8) | blue }))
    }) ?? []
    return { points, pointColors: btoa(rgb), people, overlays }
  }, [preview])
  if (!preview) return <p className="waiting">On iPhone, enable Preview hazard models and Share 3D scan with dashboard.</p>

  const depth = preview.depthPreview
  const width = depth?.width ?? 100
  const height = depth?.height ?? 100
  return <>
    <div className="model-preview-toolbar">
      <div className="scan-modes" role="group" aria-label="Model preview view">
        <button aria-pressed={view === 'separate'} onClick={() => setView('separate')}>Overlays</button>
        <button aria-pressed={view === 'combined'} onClick={() => setView('combined')}>Combined overlay</button>
        <button aria-pressed={view === 'detections'} onClick={() => setView('detections')}>3D detections</button>
        <button aria-pressed={view === 'scan'} onClick={() => setView('scan')}>3D scan overlay</button>
      </div>
      <span>{Math.round(preview.latencyMs)} ms · {preview.partial ? 'First results' : 'Preview only'}</span>
      {!spatial && <span>{depth ? 'Depth backdrop · 0–3 m color range' : 'No depth backdrop in this model frame'}</span>}
    </div>
    {view === 'scan' ? preview.scan ? <>
      <PointCloud points={preview.scan.points} pointColors={preview.scan.pointColors} overlayPoints={geometry.overlays}
        hazards={geometry.people} heading={null} phone colorLabel={preview.scan.pointColors ? 'Camera color with model detections' : 'Height colors with model detections'} />
      <div className="legend">Cyan: glass depth returns · Orange: stairs · Dashed lines: estimated pedestrian motion</div>
    </> : <p className="waiting">No 3D scan arrived with this model frame. Check scan sharing and the installed iPhone build.</p>
      : view === 'combined' ? <div className="model-images model-combined">
      <figure>
        <div className="model-scene" style={{ aspectRatio: width / height }}>
          <SceneImage masks={preview.masks} depth={depth} />
          <PersonBoxes people={preview.people} width={width} height={height} />
        </div>
        <span>Cyan mask: glass · Orange: riser · Yellow: tread · Outline: person</span>
      </figure>
    </div> : view === 'detections' ? <>
      <PointCloud points={geometry.points} pointColors={geometry.pointColors} hazards={geometry.people} heading={null} phone
        colorLabel="Glass and stair depth returns" />
      <div className="legend">Glass returns may be behind the glass. Dashed lines show estimated pedestrian motion.</div>
    </> : <div className="model-images">
      {(['glass', 'stairs'] as const).map(kind => {
        const mask = preview.masks.find(item => item.kind === kind)
        const hasDetection = mask && /[^\x00]/.test(atob(mask.labels))
        return <figure key={kind}>
          <figcaption>{kind === 'glass' ? 'Glass' : 'Stairs'}</figcaption>
          {(mask || depth) && <div className="model-scene" style={{ aspectRatio: width / height }}>
            <SceneImage masks={mask ? [mask] : undefined} depth={depth} />
          </div>}
          <span>{mask && !hasDetection ? `No ${kind === 'glass' ? 'glass' : 'stairs'} detected` : preview.models[kind]}</span>
          {kind === 'stairs' && mask && <span>Orange: riser · Yellow: tread</span>}
        </figure>
      })}
      <figure>
        <figcaption>People</figcaption>
        <div className="model-scene" style={{ aspectRatio: width / height }}>
        {depth && <SceneImage depth={depth} />}
        <PersonBoxes people={preview.people} width={width} height={height} />
        </div>
        <span>{preview.models.person} · {preview.people.length} detections</span>
      </figure>
    </div>}
  </>
}
