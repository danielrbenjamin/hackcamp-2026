import { useEffect, useMemo, useRef, useState } from 'react'
import type { Hazard, ModelPreview as Preview } from '../shared/contracts'
import { PointCloud } from './PointCloud'

const glass = [84, 203, 237]
const riser = [248, 166, 96]
const tread = [251, 215, 123]

function MaskImage({ mask }: { mask: Preview['masks'][number] }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const context = canvas.current?.getContext('2d')
    if (!context) return
    const pixels = context.createImageData(mask.size, mask.size)
    const labels = atob(mask.labels)
    for (let i = 0; i < labels.length; i++) {
      const label = labels.charCodeAt(i)
      const color = label === 0 ? [12, 19, 28] : mask.kind === 'glass' ? glass : label === 1 ? riser : tread
      pixels.data.set([...color, 255], i * 4)
    }
    context.putImageData(pixels, 0, 0)
  }, [mask])
  return <canvas ref={canvas} width={mask.size} height={mask.size} role="img"
    aria-label={mask.kind === 'glass' ? 'Glass mask' : 'Stair tread and riser mask'} />
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

  return <>
    <div className="model-preview-toolbar">
      <div className="scan-modes" role="group" aria-label="Model preview view">
        <button aria-pressed={!spatial} onClick={() => setSpatial(false)}>Masks and boxes</button>
        <button aria-pressed={spatial} onClick={() => setSpatial(true)}>3D detections</button>
      </div>
      <span>{Math.round(preview.latencyMs)} ms · Preview only</span>
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
          {mask && <MaskImage mask={mask} />}
          <span>{preview.models[kind]}</span>
          {kind === 'stairs' && mask && <span>Orange: riser · Yellow: tread</span>}
        </figure>
      })}
      <figure>
        <figcaption>People</figcaption>
        <svg viewBox="0 0 100 100" role="img" aria-label="Person boxes in camera image coordinates">
          {preview.people.map(({ box: [x, y, w, h], confidence }, index) => <g key={index}>
            <rect x={x * 100} y={y * 100} width={w * 100} height={h * 100} fill="none" stroke="#a7edff" strokeWidth="0.6" />
            <text x={x * 100 + 1} y={Math.max(6, y * 100 - 1)} fill="#a7edff" fontSize="5">{Math.round(confidence * 100)}%</text>
          </g>)}
        </svg>
        <span>{preview.models.person} · {preview.people.length} detections</span>
      </figure>
    </div>}
  </>
}
