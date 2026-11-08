import { useEffect, useMemo, useRef, useState } from 'react'
import type { Hazard, ModelPreview as Preview } from '../shared/contracts'
import { PointCloud } from './PointCloud'

const glass = [84, 203, 237]
const riser = [248, 166, 96]
const tread = [251, 215, 123]

function SceneImage({ mask, depth }: { mask?: Preview['masks'][number]; depth?: Preview['depthPreview'] }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const width = depth?.width ?? mask?.size ?? 96
  const height = depth?.height ?? mask?.size ?? 96
  useEffect(() => {
    const context = canvas.current?.getContext('2d')
    if (!context) return
    const pixels = context.createImageData(width, height)
    const labels = mask ? atob(mask.labels) : ''
    const samples = depth ? atob(depth.samples) : ''
    for (let i = 0; i < width * height; i++) {
      const cm = (samples.charCodeAt(i * 2) | (samples.charCodeAt(i * 2 + 1) << 8)) & 0x3fff
      const shade = cm ? 36 + 96 * (1 - Math.min(cm / 500, 1)) : 12
      const maskX = mask ? Math.floor((i % width) * mask.size / width) : 0
      const maskY = mask ? Math.floor(Math.floor(i / width) * mask.size / height) : 0
      const label = mask ? labels.charCodeAt(maskY * mask.size + maskX) : 0
      const color = label ? mask?.kind === 'glass' ? glass : label === 1 ? riser : tread : null
      for (let channel = 0; channel < 3; channel++) {
        pixels.data[i * 4 + channel] = color ? shade * 0.3 + color[channel] * 0.7 : shade
      }
      pixels.data[i * 4 + 3] = 255
    }
    context.putImageData(pixels, 0, 0)
  }, [depth, mask, width, height])
  return <canvas ref={canvas} width={width} height={height} role="img"
    aria-label={mask?.kind === 'glass' ? 'Glass mask' : mask ? 'Stair tread and riser mask' : 'Depth scene'} />
}

export function ModelPreview({ preview }: { preview?: Preview }) {
  const [spatial, setSpatial] = useState(false)
  const geometry = useMemo(() => {
    const points = preview?.masks.flatMap(mask => mask.points) ?? []
    const rgb = preview?.masks.map(mask => String.fromCharCode(...(mask.kind === 'glass' ? glass : riser))
      .repeat(mask.points.length)).join('') ?? ''
    const people: Hazard[] = preview?.people.flatMap(person => person.position
      ? [{ kind: 'person', confidence: person.confidence, position: person.position, predictedPosition: person.predictedPosition }]
      : []) ?? []
    return { points, pointColors: btoa(rgb), people }
  }, [preview])
  if (!preview) return <p className="waiting">On iPhone, enable Preview hazard models and Share 3D scan with dashboard.</p>

  const depth = preview.depthPreview
  const width = depth?.width ?? 100
  const height = depth?.height ?? 100
  return <>
    <div className="model-preview-toolbar">
      <div className="scan-modes" role="group" aria-label="Model preview view">
        <button aria-pressed={!spatial} onClick={() => setSpatial(false)}>Overlays</button>
        <button aria-pressed={spatial} onClick={() => setSpatial(true)}>3D detections</button>
      </div>
      <span>{Math.round(preview.latencyMs)} ms · Preview only</span>
      {!spatial && <span>{depth ? 'Aligned depth backdrop' : 'No depth backdrop in this model frame'}</span>}
    </div>
    {spatial ? <>
      <PointCloud points={geometry.points} pointColors={geometry.pointColors} hazards={geometry.people} heading={null} phone
        colorLabel="Glass and stair depth returns" />
      <div className="legend">Glass returns may be behind the glass. Dashed lines show estimated pedestrian motion.</div>
    </> : <div className="model-images">
      {(['glass', 'stairs'] as const).map(kind => {
        const mask = preview.masks.find(item => item.kind === kind)
        return <figure key={kind}>
          <figcaption>{kind === 'glass' ? 'Glass' : 'Stairs'}</figcaption>
          {(mask || depth) && <div className="model-scene" style={{ aspectRatio: width / height }}>
            <SceneImage mask={mask} depth={depth} />
          </div>}
          <span>{preview.models[kind]}</span>
          {kind === 'stairs' && mask && <span>Orange: riser · Yellow: tread</span>}
        </figure>
      })}
      <figure>
        <figcaption>People</figcaption>
        <div className="model-scene" style={{ aspectRatio: width / height }}>
        {depth && <SceneImage depth={depth} />}
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Person boxes in camera image coordinates">
          {preview.people.map(({ box: [x, y, w, h], confidence }, index) => <g key={index}>
            <rect x={x * width} y={y * height} width={w * width} height={h * height} fill="none" stroke="#a7edff" strokeWidth="2" vectorEffect="non-scaling-stroke" />
            <text x={x * width + 2} y={Math.max(height * 0.07, y * height - 2)} fill="#a7edff" fontSize={height * 0.055}>{Math.round(confidence * 100)}%</text>
          </g>)}
        </svg>
        </div>
        <span>{preview.models.person} · {preview.people.length} detections</span>
      </figure>
    </div>}
  </>
}
