import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { HAZARD_LABELS, HEADINGS, ZONE_NAMES, type ModelPreview as Preview, type Telemetry } from '../shared/contracts'
import { createLoop } from '../shared/guidance'
import { createMock, scenarios, type Scenario } from '../shared/mock'
import { LANTERN_BANNER } from '../shared/lantern'
import { PointCloud, simulatedPoints } from './PointCloud'
import { DepthImages } from './DepthImages'
import { ModelPreview } from './ModelPreview'
import { plottedZones, RangePlot } from './RangePlot'
import { EditorWorkspace, initialLayout, type EditorView } from './EditorWorkspace'
import './style.css'

const cueLabels = { idle: 'Waiting for guidance', direction: 'Directional cue', obstacle: 'Obstacle warning', unavailable: 'Depth unavailable' }
const cellColors = ['#101722', '#275260', '#f5ae5e']
type Evaluation = { model_version: string; candidate_accuracy: number; baseline_accuracy: number }
type VisualFrame = { frame: Telemetry; stream: string }
type VisualResponse = VisualFrame & { reuseScan?: boolean; reusePreview?: boolean; modelUsesScan?: boolean }

function Dashboard() {
  const [mock] = useState(createMock)
  const [scenario, setScenario] = useState<Scenario>('walk')
  const [connected, setConnected] = useState(true)
  const [simulation, setSimulation] = useState<Telemetry>()
  const [phone, setPhone] = useState<Telemetry>()
  const [phoneStream, setPhoneStream] = useState<string>()
  const [phoneVisuals, setPhoneVisuals] = useState<VisualFrame | null>(null)
  const [completePreview, setCompletePreview] = useState<{ preview: Preview; stream: string } | null>(null)
  const [phoneReceivedAt, setPhoneReceivedAt] = useState<number>()
  const [tokenInput, setTokenInput] = useState('')
  const [token, setToken] = useState('')
  const [link, setLink] = useState('')
  const [layout, setLayout] = useState(initialLayout)
  const [mutedDepth, setMutedDepth] = useState(false)
  const [evaluation, setEvaluation] = useState<Evaluation>()
  const [evaluationError, setEvaluationError] = useState('')
  const [events, setEvents] = useState<{ time: number; text: string }[]>([])
  const [terminal, setTerminal] = useState(true)
  const [lowerView, setLowerView] = useState<'plot' | 'terminal'>('plot')
  const [sidePane, setSidePane] = useState<'explorer' | 'inspector' | null>(null)
  const [inspection, setInspection] = useState<'guidance' | 'model' | 'belt'>('guidance')
  const [commandInput, setCommandInput] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const terminalOutput = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const output = terminalOutput.current
    if (output) output.scrollTop = output.scrollHeight
  }, [events, history, terminal, lowerView])

  useEffect(() => {
    const loop = createLoop(mock.providers)
    const tick = () => setSimulation(loop.tick())
    tick()
    const timer = window.setInterval(tick, 150)
    return () => { window.clearInterval(timer); loop.stop() }
  }, [mock])

  useEffect(() => {
    if (!token) return
    let timer: number | undefined
    const controller = new AbortController()
    async function poll() {
      try {
        const response = await fetch('/api/telemetry', { signal: controller.signal,
          headers: { Authorization: `Bearer ${token}` } })
        if (!response.ok) throw new Error(`Relay returned ${response.status}`)
        const data = await response.json() as { receivedAt: number; frame: Telemetry; stream?: string } | null
        if (controller.signal.aborted) return
        if (data) setPhoneReceivedAt(data.receivedAt)
        setPhoneStream(data?.stream)
        const fresh = data && Date.now() - data.receivedAt < 2_000
        setPhone(fresh ? data.frame : undefined)
        setLink(fresh ? 'Receiving phone telemetry' : 'Waiting for phone telemetry')
      } catch (error) {
        if (controller.signal.aborted) return
        setPhone(undefined)
        setLink(error instanceof Error ? error.message : 'Relay unavailable')
      }
      timer = window.setTimeout(poll, 120)
    }
    void poll()
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [token])

  useEffect(() => {
    if (!token) return
    const controller = new AbortController()
    const timers: number[] = []
    let needsCompletePreview = false
    let cachedVisuals: VisualFrame | null = null
    function watch<T>(path: string, update: (data: T | null) => void, interval: number, enabled = () => true,
      requestHeaders?: () => Record<string, string>) {
      const index = timers.length
      timers.push(0)
      let etag: string | null = null
      async function poll() {
        if (!enabled()) {
          if (!controller.signal.aborted) timers[index] = window.setTimeout(poll, interval)
          return
        }
        try {
          const headers: Record<string, string> = { Authorization: `Bearer ${token}`, ...requestHeaders?.() }
          if (etag) headers['If-None-Match'] = etag
          const response = await fetch(`/api/telemetry/${path}`, { headers, signal: controller.signal })
          if (response.ok) {
            const data = await response.json() as T | null
            if (!controller.signal.aborted) {
              etag = response.headers.get('ETag')
              update(data)
            }
          }
        } catch { /* The lightweight feed reports connection status separately. */ }
        if (!controller.signal.aborted) timers[index] = window.setTimeout(poll, interval)
      }
      void poll()
    }
    watch<VisualResponse>('visuals', data => {
      if (data) {
        const previous = cachedVisuals?.stream === data.stream ? cachedVisuals.frame : undefined
        const observation = data.frame.observation
        if (data.reuseScan && previous) {
          observation.denseScan = previous.observation.denseScan
          observation.depthPreview = previous.observation.depthPreview
          observation.smoothedDepthPreview = previous.observation.smoothedDepthPreview
        }
        if (data.reusePreview) data.frame.modelPreview = previous?.modelPreview
        else if (data.modelUsesScan && data.frame.modelPreview) data.frame.modelPreview.denseScan = observation.denseScan
      }
      cachedVisuals = data
      const preview = cachedVisuals?.frame.modelPreview
      needsCompletePreview = !!preview && (!!preview.partial || !(preview.denseScan || preview.scan))
      setPhoneVisuals(cachedVisuals)
    }, 180, undefined, () => {
      const scan = cachedVisuals?.frame.observation.denseScan
      const preview = cachedVisuals?.frame.modelPreview
      return {
        'X-Lantern-Visual-Stream': cachedVisuals?.stream ?? '',
        'X-Lantern-Known-Scan': scan ? String(scan.timeMs) : '',
        'X-Lantern-Known-Preview': preview ? `${preview.timeMs}/${preview.latencyMs}/${preview.partial}` : '',
      }
    })
    watch<{ preview: Preview; stream: string }>('complete-preview', setCompletePreview, 350, () => needsCompletePreview)
    return () => { controller.abort(); timers.forEach(timer => window.clearTimeout(timer)) }
  }, [token])

  const visualFrame = phone && phoneStream && phoneVisuals?.stream === phoneStream ? phoneVisuals.frame : undefined
  const latestPreview = visualFrame?.modelPreview
  const finishedPreview = latestPreview && completePreview?.stream === phoneStream
    ? completePreview?.preview : undefined
  const frame = token ? phone && visualFrame ? {
    ...phone, modelPreview: visualFrame.modelPreview,
    observation: {
      ...phone.observation,
      points: visualFrame.observation.points, pointColors: visualFrame.observation.pointColors,
      denseScan: visualFrame.observation.denseScan, depthPreview: visualFrame.observation.depthPreview,
      smoothedDepthPreview: visualFrame.observation.smoothedDepthPreview, hazards: visualFrame.observation.hazards,
    },
  } : phone : simulation
  const latestHasScan = !!(latestPreview?.denseScan || latestPreview?.scan)
  const finishedHasScan = !!(finishedPreview?.denseScan || finishedPreview?.scan)
  const overlayPreview = finishedHasScan && (!latestHasScan || latestPreview?.partial)
    ? finishedPreview : frame?.modelPreview
  const cueLabel = frame?.modelWarning ? HAZARD_LABELS[frame.modelWarning] : frame ? cueLabels[frame.command.cue] : undefined
  const eventText = frame ? `${cueLabel} · ${frame.belt.connected ? 'belt online' : 'belt offline'}` : null
  const eventTime = frame?.observation.timeMs
  useEffect(() => {
    if (!eventText || !eventTime) return
    setEvents(current => current[0]?.text === eventText ? current : [{ time: eventTime, text: eventText }, ...current].slice(0, 6))
  }, [eventText, eventTime])

  const controls = <form className="link-form" onSubmit={event => {
    event.preventDefault()
    setPhone(undefined)
    setPhoneStream(undefined)
    setPhoneVisuals(null)
    setCompletePreview(null)
    setPhoneReceivedAt(undefined)
    setEvents([])
    setLink(token ? '' : 'Connecting…')
    setToken(token ? '' : tokenInput.trim())
  }}>
    {!token && <input className="relay-token" aria-label="Telemetry token" type="password" autoComplete="off"
      placeholder="Telemetry token" value={tokenInput} onChange={event => setTokenInput(event.target.value)} />}
    <button type="submit" disabled={!token && !tokenInput.trim()}>{token ? 'Return to simulation' : 'Connect phone feed'}</button>
    {token && <span className="dim" role="status">{link}</span>}
  </form>

  const observation = frame?.observation
  const grid = observation?.grid
  const heading = frame?.heading ?? null
  const detections = observation?.hazards
  const blocked = frame?.blockedHeadings
  const hazardHold = heading === null && frame?.baselineHeading != null && blocked?.includes(frame.baselineHeading)
  const route = frame?.route
  const belt = frame?.belt
  const command = frame?.command
  const reflex = frame?.reflex
  const zonesWithDepth = observation && plottedZones.filter(zone => {
    const value = observation.zones[zone]
    return value !== null && Number.isFinite(value) && value > 0
  }).length
  const lastFrameAt = token ? phoneReceivedAt : observation?.timeMs
  const sensorStatus = !observation ? lastFrameAt ? 'Feed interrupted' : 'Waiting for feed'
    : !zonesWithDepth ? 'Depth unavailable' : reflex === 'unknown' ? 'Limited depth' : 'Receiving depth'
  const radians = (heading ?? 0) * Math.PI / 180
  const source = token ? observation?.source === 'arkit' ? 'iPhone LiDAR' : observation ? 'Phone simulation' : 'iPhone' : 'Simulation'

  function openView(view: EditorView) {
    setLayout(current => ({ ...current, groups: current.groups.map(group =>
      group.tabs.includes(view) ? { ...group, active: view } : group) }))
  }

  function runCommand() {
    const input = commandInput.trim().toLowerCase()
    setCommandInput('')
    if (!input) return
    if (input === 'clear') { setHistory([]); return }
    let result = 'Unknown command. Type help.'
    if (input === 'help') result = 'help   status   scan   grid   clear'
    if (input === 'status') result = [source, reflex ?? 'no depth', belt?.connected ? 'belt online' : 'belt offline'].join(' / ')
    if (input === 'scan' || input === 'grid') {
      openView(input === 'scan' ? 'cloud' : 'grid')
      result = input === 'scan' ? '3D scan open' : 'Occupancy grid open'
    }
    setHistory(current => [...current, '> ' + input, result].slice(-12))
  }

  return (
    <main className="workbench">
      <header><h1 className="sr-only">Lantern</h1><pre className="wordmark" aria-hidden="true">{LANTERN_BANNER}</pre></header>
      <div className="workarea">
        <nav className="activity" aria-label="Workspace panes">
          <button title="3D scan" aria-label="Open 3D scan" aria-pressed={layout.groups.some(group => group.active === 'cloud')} onClick={() => openView('cloud')}>[+]</button>
          <button title="Plotter and terminal" aria-label="Toggle plotter and terminal" aria-pressed={terminal} onClick={() => setTerminal(!terminal)}>&gt;_</button>
          <button className="pane-toggle" title="Explorer" aria-label="Toggle Explorer" aria-controls="explorer"
            aria-expanded={sidePane === 'explorer'} onClick={() => setSidePane(sidePane === 'explorer' ? null : 'explorer')}>[=]</button>
          <button className="pane-toggle" title="Inspector" aria-label="Toggle Inspector" aria-controls="inspector"
            aria-expanded={sidePane === 'inspector'} onClick={() => setSidePane(sidePane === 'inspector' ? null : 'inspector')}>[i]</button>
        </nav>
        <aside id="explorer" className="explorer" aria-label="Explorer" data-open={sidePane === 'explorer'}>
          <div className="pane-label side-heading"><h2>Explorer</h2>
            <button className="pane-toggle" aria-label="Close Explorer" onClick={() => setSidePane(null)}>×</button>
          </div>
          <section className="side-section">
            <h3>Depth source</h3>
            <div className="tree-item"><i className="indicator" data-on={Boolean(frame)} />{source}</div>
            {controls}
          </section>
          {!token && <section className="side-section" aria-label="Simulator controls">
            <h3>Scenarios</h3>
            {(Object.entries(scenarios) as [Scenario, string][]).map(([value, label]) => (
              <button className="tree-button" key={value} aria-pressed={scenario === value}
                onClick={() => { mock.setScenario(value); setScenario(value) }}><span aria-hidden="true">{scenario === value ? '>' : '|'}</span>{label}</button>
            ))}
            <button className="outline-button belt-control" onClick={() => { mock.setConnected(!connected); setConnected(!connected) }}>
              {connected ? 'Disconnect belt' : 'Reconnect belt'}
            </button>
          </section>}
          <section className="side-section">
            <h3>Sensor status</h3>
            <dl className="readouts">
              <div><dt>Depth</dt><dd>{sensorStatus}</dd></div>
              <div><dt>Zones with depth</dt><dd>{zonesWithDepth === undefined ? '—' : `${zonesWithDepth} / ${plottedZones.length}`}</dd></div>
              <div><dt>Last frame</dt><dd>{lastFrameAt ? new Date(lastFrameAt).toLocaleTimeString('en-GB') : '—'}</dd></div>
            </dl>
          </section>
        </aside>
        <section className="editor" aria-label="Scan workspace">
          <EditorWorkspace layout={layout} setLayout={setLayout} renderView={mapView =>
            mapView === 'combined' || mapView === 'separate' || mapView === 'scan'
              ? <ModelPreview view={mapView} preview={overlayPreview} mutedDepth={mutedDepth} setMutedDepth={setMutedDepth} />
              : mapView === 'depth' ? <DepthImages observation={observation} />
              : !grid || !observation ? <p className="waiting">{link || 'Waiting for depth data'}</p>
              : mapView === 'cloud' ? <PointCloud points={observation.source === 'simulated' ? simulatedPoints(grid) : observation.points}
                heading={heading} hazards={detections} phone={observation.source === 'arkit'}
                pointColors={observation.pointColors} denseScan={observation.denseScan} depthPreview={observation.depthPreview} fillRecent /> : <>
                <div className="scan">
                  <svg className="map" viewBox={`0 0 ${grid.width} ${grid.height}`} role="img" aria-label="Occupancy grid with device at bottom centre">
                    {grid.cells.map((cell, i) => <rect key={i} x={i % grid.width} y={Math.floor(i / grid.width)} width=".94" height=".94" fill={cellColors[cell]} />)}
                    {heading !== null && <line x1="20" y1="19.5" x2={20 + 10 * Math.sin(radians)} y2={19.5 - 10 * Math.cos(radians)} stroke="#afffe5" strokeWidth=".2" strokeDasharray=".4 .35" />}
                    <path d="M 20 18.7 L 19.5 19.7 L 20.5 19.7 Z" fill="#f4f8ff" />
                  </svg>
                </div>
                <div className="legend">
                  <div className="legend-items">{['Unknown', 'Observed free', 'Occupied'].map((label, i) => <span key={label}><i style={{ background: cellColors[i] }} />{label}</span>)}</div>
                  <span>{grid.height * grid.cellM} m forward / {grid.cellM} m cells</span>
                </div>
              </>}
          />
          {terminal && <section className="terminal" aria-label="Plotter and terminal">
            <div className="pane-label terminal-head">
              <div className="terminal-tabs" role="group" aria-label="Lower panel">
                <button aria-pressed={lowerView === 'plot'} onClick={() => setLowerView('plot')}>Plotter</button>
                <button aria-pressed={lowerView === 'terminal'} onClick={() => setLowerView('terminal')}>Terminal</button>
              </div>
              <button aria-label="Close lower panel" onClick={() => setTerminal(false)}>×</button>
            </div>
            <RangePlot key={token ? 'phone' : 'simulation'} frame={frame} hidden={lowerView !== 'plot'} />
            <div hidden={lowerView !== 'terminal'}>
            <div ref={terminalOutput} className="terminal-output" aria-label="Telemetry and command output">
              {[...events].reverse().map((event, i) => <div key={`${event.time}-${i}`} className="log-line">
                <time dateTime={new Date(event.time).toISOString()}>{new Date(event.time).toLocaleTimeString('en-GB')}</time>
                <span className="log-topic">guidance</span><span>{event.text}</span>
              </div>)}
              {history.map((line, i) => <div className={line.startsWith('> ') ? 'terminal-command' : 'terminal-reply'} key={i}>{line}</div>)}
            </div>
            <form className="prompt" onSubmit={event => { event.preventDefault(); runCommand() }}>
              <label htmlFor="terminal-input" aria-hidden="true">lantern&gt;</label>
              <input id="terminal-input" aria-label="Terminal command" value={commandInput} onChange={event => setCommandInput(event.target.value)}
                placeholder="Type help" autoComplete="off" spellCheck={false} />
            </form>
            </div>
          </section>}
        </section>

        <aside id="inspector" className="inspector" aria-label="Inspector" data-open={sidePane === 'inspector'}>
          <div className="pane-label side-heading"><h2>Inspector</h2>
            <button className="pane-toggle" aria-label="Close Inspector" onClick={() => setSidePane(null)}>×</button>
          </div>
          <div className="inspector-tabs" role="group" aria-label="Inspector sections">
            <button aria-pressed={inspection === 'guidance'} onClick={() => setInspection('guidance')}>Guidance</button>
            <button aria-pressed={inspection === 'model'} onClick={() => setInspection('model')}>Model</button>
            <button aria-pressed={inspection === 'belt'} onClick={() => setInspection('belt')}>Belt</button>
          </div>
          <section className="inspector-section" data-current={inspection === 'guidance'}>
            <h3>Guidance</h3>
            <div className={`decision ${command?.cue === 'obstacle' || hazardHold || (reflex && reflex !== 'clear') ? 'hazard' : ''}`}>
              <strong>{command?.cue !== 'obstacle' && hazardHold ? 'Caution · direction withheld' : cueLabel ?? 'No telemetry'}</strong><span>{heading === null ? '—' : `${heading}°`}</span>
            </div>
            <dl className="readouts">
              <div><dt>Route</dt><dd>{route ? `${route.source === 'google' ? 'Google' : 'Simulated'} / ${route.status}` : '—'}</dd></div>
              {route?.destination && <div><dt>Destination</dt><dd>{route.destination}</dd></div>}
              {route?.maneuver && <div><dt>Maneuver</dt><dd>{route.maneuver}</dd></div>}
              <div><dt>Desired heading</dt><dd>{route?.desiredHeading == null ? '—' : `${route.desiredHeading.toFixed(0)}°`}</dd></div>
              <div><dt>Reflex</dt><dd>{reflex ?? '—'}</dd></div>
              {frame?.reflexDispatchMs !== undefined && <div><dt>Sensor to dispatch</dt><dd>{frame.reflexDispatchMs.toFixed(0)} ms</dd></div>}
              <div><dt>Clearance baseline</dt><dd>{frame?.baselineHeading == null ? '—' : `${frame.baselineHeading}°`}</dd></div>
            </dl>
          </section>
          <section className="inspector-section" data-current={inspection === 'model'}>
          <h3>Hazards</h3>
          <dl className="readouts">
            <div><dt>Detections</dt><dd>{detections === undefined ? 'Unavailable' : detections.length}</dd></div>
            <div><dt>Blocked headings</dt><dd>{HEADINGS.filter(angle => blocked?.includes(angle)).map(angle => `${angle}°`).join(', ') || '—'}</dd></div>
            {detections?.map((detection, index) => <div key={index}>
              <dt>{HAZARD_LABELS[detection.kind]}</dt>
              <dd>{Math.round(detection.confidence * 100)}% · {'position' in detection ? '3D' : 'Depth unknown'}</dd>
            </div>)}
          </dl>
          <label className="evaluation">
            Legacy traversability evaluation
            <input type="file" accept=".json,application/json" onChange={event => {
              const file = event.target.files?.[0]
              if (!file) return
              void file.text().then(data => {
                const report: Evaluation = JSON.parse(data)
                if (typeof report.model_version !== 'string' || ![report.candidate_accuracy, report.baseline_accuracy]
                  .every(value => Number.isFinite(value) && value >= 0 && value <= 1)) throw new Error()
                setEvaluation(report)
                setEvaluationError('')
              }).catch(() => { setEvaluation(undefined); setEvaluationError('Invalid MLflow evaluation report.') })
            }} />
          </label>
          {evaluationError && <p role="status">{evaluationError}</p>}
          {evaluation && <p className="evaluation">
            {evaluation.model_version} · Candidate labels · Model {(evaluation.candidate_accuracy * 100).toFixed(1)}%
            {' · '}Baseline {(evaluation.baseline_accuracy * 100).toFixed(1)}%
          </p>}
          </section>
          <section className="inspector-section" data-current={inspection === 'belt'}>
          <h3>Belt output</h3>
          <p className="dim">{belt?.source === 'simulated' ? 'Simulated / ' : ''}{belt?.connected ? `Connected${belt.battery === null ? '' : ` / ${belt.battery}% battery`}` : 'Disconnected'}</p>
          <div className="zones motors">
            {ZONE_NAMES.map((name, i) => <div key={name} title={name} aria-label={name}
              data-active={Boolean(belt?.connected && (command?.motors[i] ?? 0) > 0)}
              data-alert={command?.cue === 'obstacle'}><strong>{i + 1}</strong><span>{['LL', 'L', 'C', 'R', 'RR'][i]}</span></div>)}
          </div>
          </section>
        </aside>
      </div>
      <footer className="statusbar">
        <span>Reflex {reflex ?? '—'}</span>
        <span><i className="belt-indicator" data-on={Boolean(belt?.connected)} aria-hidden="true" />Belt {belt?.connected ? 'online' : 'offline'}</span>
      </footer>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Dashboard />)
