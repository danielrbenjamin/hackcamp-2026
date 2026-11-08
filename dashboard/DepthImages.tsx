import { useEffect, useRef } from 'react'
import type { Observation } from '../shared/contracts'

const confidenceColors = [[236, 99, 85], [242, 192, 93], [76, 198, 178]]

export function DepthImages({ observation }: { observation?: Observation }) {
  const preview = observation?.depthPreview
  const depth = useRef<HTMLCanvasElement>(null)
  const confidence = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const depthContext = depth.current?.getContext('2d')
    const confidenceContext = confidence.current?.getContext('2d')
    if (!preview || !depthContext || !confidenceContext) return
    const samples = atob(preview.samples)
    const distance = depthContext.createImageData(preview.width, preview.height)
    const quality = confidenceContext.createImageData(preview.width, preview.height)
    for (let i = 0; i < preview.width * preview.height; i++) {
      const sample = samples.charCodeAt(i * 2) | (samples.charCodeAt(i * 2 + 1) << 8)
      const cm = sample & 0x3fff
      const t = Math.min(cm / 500, 1)
      distance.data.set(cm ? [35 + 220 * t, 85 + 150 * t, 230 - 180 * t, 255] : [0, 0, 0, 255], i * 4)
      const color = cm ? confidenceColors[sample >> 14] : undefined
      quality.data.set(color ? [...color, 255] : [0, 0, 0, 255], i * 4)
    }
    depthContext.putImageData(distance, 0, 0)
    confidenceContext.putImageData(quality, 0, 0)
  }, [preview])

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
      <canvas ref={depth} width={preview.width} height={preview.height} role="img" aria-label="Depth image from zero to five metres" />
      <div className="depth-key"><span>Near</span><i className="depth-scale" /><span>5 m</span></div>
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
