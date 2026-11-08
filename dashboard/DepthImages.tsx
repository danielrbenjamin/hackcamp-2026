import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import type { DenseScan, DepthPreview, Observation } from '../shared/contracts'
import { denseScanData } from './denseScan'

const confidenceColors = [[236, 99, 85], [242, 192, 93], [76, 198, 178]]
const confidenceLabels = ['Low', 'Medium', 'High']
const distanceColors = [[40, 38, 156], [37, 112, 219], [76, 217, 229], [247, 222, 84], [235, 92, 41]]
export const DEFAULT_DEPTH_RANGE_M = 3

export function distancePalette(maxCm: number) {
  return Array.from({ length: 501 }, (_, cm) => {
    if (!cm) return [0, 0, 0, 255]
    const position = Math.min(cm / maxCm, 1) * (distanceColors.length - 1)
    const index = Math.min(Math.floor(position), distanceColors.length - 2)
    const start = distanceColors[index]
    const end = distanceColors[index + 1]
    return [...start.map((channel, i) => channel + (end[i] - channel) * (position - index)), 255]
  })
}

function renderDistanceImage(width: number, height: number, colors: number[][], centimetersAt: (index: number) => number) {
  const pixels = new ImageData(width, height)
  for (let i = 0; i < width * height; i++) {
    pixels.data.set(colors[Math.min(centimetersAt(i), 500)], i * 4)
  }
  return pixels
}

function packedDepthSample(samples: string, index: number) {
  return samples.charCodeAt(index * 2) | (samples.charCodeAt(index * 2 + 1) << 8)
}

export function renderDepthRaster(scan: DenseScan | undefined, depth: DepthPreview | undefined, colors: number[][]) {
  if (depth) {
    const samples = atob(depth.samples)
    return renderDistanceImage(depth.width, depth.height, colors, i => packedDepthSample(samples, i) & 0x3fff)
  }
  if (!scan) return undefined
  const raster = denseScanData(scan)
  return renderDistanceImage(scan.width, scan.height, colors, i => {
    const meters = raster.getFloat32(i * 8, true)
    return Number.isFinite(meters) && meters > 0 ? Math.max(1, Math.round(meters * 100)) : 0
  })
}

export function DepthRaster({ pixels }: { pixels: ImageData }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    canvas.current?.getContext('2d')?.putImageData(pixels, 0, 0)
  }, [pixels])
  return <canvas ref={canvas} width={pixels.width} height={pixels.height} role="img" aria-label="LiDAR depth map"
    style={{ display: 'block', width: '100%', height: '100%', imageRendering: 'pixelated' }} />
}

export function DepthImages({ observation }: { observation?: Observation }) {
  const [smooth, setSmooth] = useState(false)
  const [pixel, setPixel] = useState<{ x: number; y: number }>()
  const smoothed = smooth && !!observation?.smoothedDepthPreview
  const preview = smoothed ? observation?.smoothedDepthPreview : observation?.depthPreview
  const samples = useMemo(() => preview ? atob(preview.samples) : '', [preview])
  const [range, setRange] = useState(DEFAULT_DEPTH_RANGE_M)
  const depth = useRef<HTMLCanvasElement>(null)
  const confidence = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const depthContext = depth.current?.getContext('2d')
    const confidenceContext = confidence.current?.getContext('2d')
    if (!preview || !depthContext || !confidenceContext) return
    const palette = distancePalette(range * 100)
    const distance = renderDistanceImage(preview.width, preview.height, palette, i => packedDepthSample(samples, i) & 0x3fff)
    const quality = confidenceContext.createImageData(preview.width, preview.height)
    for (let i = 0; i < preview.width * preview.height; i++) {
      const sample = packedDepthSample(samples, i)
      const cm = sample & 0x3fff
      const color = cm ? confidenceColors[sample >> 14] : undefined
      quality.data.set(color ? [...color, 255] : [0, 0, 0, 255], i * 4)
    }
    depthContext.putImageData(distance, 0, 0)
    confidenceContext.putImageData(quality, 0, 0)
  }, [preview, range, samples])

  if (!preview) {
    const message = observation?.source !== 'arkit' ? 'Waiting for live iPhone LiDAR telemetry.'
      : observation.points === undefined && !observation.denseScan ? 'Turn on Share 3D scan with dashboard in Lantern.'
      : observation.points?.length === 0 ? 'Scan sharing is on. Waiting for usable LiDAR returns.'
      : 'The iPhone is sending 3D points but no depth or confidence image. Check the installed iOS build and reload Lantern from the latest Expo checkout.'
    return <p className="waiting">{message}</p>
  }
  const { width, height } = preview
  const sampleIndex = pixel && pixel.x < width && pixel.y < height ? 2 * (pixel.y * width + pixel.x) : undefined
  const sample = sampleIndex === undefined ? 0 : samples.charCodeAt(sampleIndex) | (samples.charCodeAt(sampleIndex + 1) << 8)
  const cm = sample & 0x3fff
  function inspect(event: PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect()
    const scale = Math.min(rect.width / width, rect.height / height)
    if (scale <= 0) return
    const x = Math.floor((event.clientX - rect.left - (rect.width - width * scale) / 2) / scale)
    const y = Math.floor((event.clientY - rect.top - (rect.height - height * scale) / 2) / scale)
    setPixel(x >= 0 && y >= 0 && x < width && y < height ? { x, y } : undefined)
  }
  return <div className="depth-images">
    <div className="depth-toolbar">
      <div className="scan-modes" role="group" aria-label="Depth source">
        <button aria-pressed={!smoothed} onClick={() => setSmooth(false)}>Raw</button>
        <button aria-pressed={smoothed} disabled={!observation?.smoothedDepthPreview} onClick={() => setSmooth(true)}>Smoothed</button>
      </div>
      <span>{pixel ? cm ? `${(cm / 100).toFixed(2)} m · ${confidenceLabels[sample >> 14] ?? 'Unknown'} confidence` : 'No depth return'
        : 'Point at either image to inspect a pixel'}</span>
    </div>
    <figure>
      <figcaption>Distance <span>{preview.width} × {preview.height}</span></figcaption>
      <canvas className="depth-distance" ref={depth} width={preview.width} height={preview.height} role="img"
        onPointerMove={inspect} onPointerDown={inspect} onPointerLeave={() => setPixel(undefined)}
        aria-label={`Depth image with a color range from zero to ${range} metres`} />
      <div className="depth-key"><span>Near</span><i className="depth-scale" /><span>{range} m</span>
        <label>Color range <select value={range} onChange={event => setRange(Number(event.target.value))}>
          {[1, 2, 3, 5].map(metres => <option key={metres} value={metres}>{metres} m</option>)}
        </select></label>
      </div>
    </figure>
    <figure>
      <figcaption>ARKit confidence</figcaption>
      <canvas ref={confidence} width={preview.width} height={preview.height} role="img"
        onPointerMove={inspect} onPointerDown={inspect} onPointerLeave={() => setPixel(undefined)}
        aria-label="Low, medium and high confidence depth samples" />
      <div className="depth-key">{confidenceLabels.map((label, i) =>
        <span key={label}><i style={{ background: `rgb(${confidenceColors[i].join(',')})` }} />{label}</span>
      )}<span>Black: no return</span></div>
    </figure>
  </div>
}
