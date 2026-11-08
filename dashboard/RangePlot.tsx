import { useEffect, useState } from 'react'
import { ZONE_NAMES, type Telemetry } from '../shared/contracts'

const windowMs = 12_000
export const plottedZones = [1, 2, 3] as const
const colors = ['#68b5ff', '#a8e68e', '#ffd080']
type Sample = { time: number; zones: Telemetry['observation']['zones']; warning: boolean }

export function RangePlot({ frame, hidden }: { frame?: Telemetry; hidden: boolean }) {
  const [samples, setSamples] = useState<Sample[]>([])
  const time = frame?.observation.timeMs
  const zones = frame?.observation.zones
  const warning = frame?.command.cue === 'obstacle'

  useEffect(() => {
    if (time === undefined || !zones) return
    setSamples(previous => {
      if (previous.at(-1)?.time === time) return previous
      if (previous.length && previous.at(-1)!.time > time) return [{ time, zones, warning }]
      const firstVisible = previous.findIndex(sample => time - sample.time <= windowMs)
      const recent = firstVisible < 0 ? previous.slice(-1) : previous.slice(Math.max(0, firstVisible - 1))
      return [...recent, { time, zones, warning }]
    })
  }, [time, zones, warning])

  const latest = samples.at(-1)
  const left = (latest?.time ?? 0) - windowMs
  const x = (time: number) => (time - left) / windowMs * 600
  const y = (meters: number) => 92 - Math.min(meters, 5) / 5 * 88
  return <div className="range-plot" hidden={hidden}>
    <div className="range-legend">
      {plottedZones.map((zone, index) => {
        const name = ZONE_NAMES[zone]
        const distance = zones?.[zone]
        return <span key={name}><i style={{ background: colors[index] }} />{name} <strong>{distance?.toFixed(2) ?? '—'} m</strong></span>
      })}
      <span><i className="range-warning-key" />Warning</span>
    </div>
    <div className="range-chart">
      <div className="range-axis" aria-hidden="true"><span>5 m</span><span>2.5</span><span>0</span></div>
      <svg viewBox="0 0 600 100" preserveAspectRatio="none" role="img" aria-label="Left, ahead, and right LiDAR distance traces over the last 12 seconds. Red marks show obstacle warnings.">
        {[4, 26, 48, 70, 92].map(row => <path key={row} d={`M0 ${row}H600`} className="range-grid" />)}
        {[0, 50, 100, 150, 200, 250, 300, 350, 400, 450, 500, 550, 600].map(col =>
          <path key={col} d={`M${col} 4V92`} className="range-grid" />)}
        {plottedZones.map((zone, index) => {
          let path = ''
          let lastTime = -Infinity
          for (const sample of samples) {
            const distance = sample.zones[zone]
            if (distance == null || !Number.isFinite(distance) || distance <= 0) {
              lastTime = -Infinity
              continue
            }
            const start = sample.time - lastTime > 1200
            path += `${start ? 'M' : 'L'}${x(sample.time)} ${y(distance)}`
            if (start) path += 'h0.01'
            lastTime = sample.time
          }
          return <path key={zone} d={path} stroke={colors[index]} fill="none" strokeWidth="1.5"
            strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        })}
        {samples.map((sample, index) => sample.warning && <rect key={sample.time}
          x={x(sample.time) - 1} y={95} height={5}
          width={Math.max(2, x(Math.min(samples[index + 1]?.time ?? sample.time, sample.time + 1200)) - x(sample.time))}
          className="range-warning-key" />)}
      </svg>
      {!frame && <span className="range-empty">Waiting for range data</span>}
    </div>
    <div className="range-times" aria-hidden="true"><span>−12 s</span><span>−6 s</span><span>Latest</span></div>
  </div>
}
