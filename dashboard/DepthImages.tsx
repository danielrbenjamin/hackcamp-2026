import { useEffect, useRef, useState } from 'react'
import type { Observation } from '../shared/contracts'

const confidenceColors = [[236, 99, 85], [242, 192, 93], [76, 198, 178]]
const distanceColors = [[40, 38, 156], [37, 112, 219], [76, 217, 229], [247, 222, 84], [235, 92, 41]]

function distancePalette(maxCm: number) {
  return Array.from({ length: 501 }, (_, cm) => {
    if (!cm) return [0, 0, 0, 255]
    const position = Math.min(cm / maxCm, 1) * (distanceColors.length - 1)
    const index = Math.min(Math.floor(position), distanceColors.length - 2)
    const start = distanceColors[index]
    const end = distanceColors[index + 1]
    return [...start.map((channel, i) => channel + (end[i] - channel) * (position - index)), 255]
  })
}

export function DepthImages({ observation }: { observation?: Observation }) {
  const preview = observation?.depthPreview
  const [range, setRange] = useState(3)
  const depth = useRef<HTMLCanvasElement>(null)
  const confidence = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const depthContext = depth.current?.getContext('2d')
    const confidenceContext = confidence.current?.getContext('2d')
    if (!preview || !depthContext || !confidenceContext) return
    const samples = atob(preview.samples)
    const palette = distancePalette(range * 100)
    const distance = depthContext.createImageData(preview.width, preview.height)
    const quality = confidenceContext.createImageData(preview.width, preview.height)
    for (let i = 0; i < preview.width * preview.height; i++) {
      const sample = samples.charCodeAt(i * 2) | (samples.charCodeAt(i * 2 + 1) << 8)
      const cm = sample & 0x3fff
      distance.data.set(palette[Math.min(cm, 500)], i * 4)
      const color = cm ? confidenceColors[sample >> 14] : undefined
      quality.data.set(color ? [...color, 255] : [0, 0, 0, 255], i * 4)
    }
    depthContext.putImageData(distance, 0, 0)
    confidenceContext.putImageData(quality, 0, 0)
  }, [preview, range])

  if (!preview) {
    const message = observation?.source !== 'arkit' ? 'Waiting for live iPhone LiDAR telemetry.'
      : observation.points === undefined ? 'Turn on Share 3D scan with dashboard in Lantern.'
      : observation.points.length === 0 ? 'Scan sharing is on. Waiting for usable LiDAR returns.'
      : 'The iPhone is sending 3D points but no depth or confidence image. Check the installed iOS build and reload Lantern from the latest Expo checkout.'
    return <p className="waiting">{message}</p>
  }
  return <div className="depth-images">
    <figure>
      <figcaption>Distance <span>{preview.width} × {preview.height}</span></figcaption>
      <canvas className="depth-distance" ref={depth} width={preview.width} height={preview.height} role="img"
        aria-label={`Depth image with a color range from zero to ${range} metres`} />
      <div className="depth-key"><span>Near</span><i className="depth-scale" /><span>{range} m</span>
        <label>Color range <select value={range} onChange={event => setRange(Number(event.target.value))}>
          {[1, 2, 3, 5].map(metres => <option key={metres} value={metres}>{metres} m</option>)}
        </select></label>
      </div>
    </figure>
    <figure>
      <figcaption>ARKit confidence</figcaption>
      <canvas ref={confidence} width={preview.width} height={preview.height} role="img" aria-label="Low, medium and high confidence depth samples" />
      <div className="depth-key">{['Low', 'Medium', 'High'].map((label, i) =>
        <span key={label}><i style={{ background: `rgb(${confidenceColors[i].join(',')})` }} />{label}</span>
      )}<span>Black: no return</span></div>
    </figure>
  </div>
}
