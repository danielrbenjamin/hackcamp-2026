import { useCallback, useEffect, useRef, useState, type ComponentRef } from 'react'
import { AppState, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { ZONE_NAMES, type BeltStatus, type Route, type Telemetry } from '../shared/contracts'
import { LANTERN_BANNER } from '../shared/lantern'
import { createLoop } from '../shared/guidance'
import { createMock, emptyObservation, type Scenario } from '../shared/mock'
import { nativeDepth, type DepthStatus } from './nativeDepth'
import GoogleRoute from './GoogleRoute'
import { RouteCard } from './RouteCard'
import { createRecording, telemetrySummary } from './session'

const telemetryUrl = process.env.EXPO_PUBLIC_TELEMETRY_URL
const telemetryToken = process.env.EXPO_PUBLIC_TELEMETRY_TOKEN
const disconnected: BeltStatus = { connected: false, battery: null, source: 'ble' }

export default function App() {
  const [mock] = useState(createMock)
  const [frame, setFrame] = useState<Telemetry>()
  const [scenario, setScenario] = useState<Scenario>('walk')
  const [native, setNative] = useState(false)
  const [status, setStatus] = useState<DepthStatus>('idle')
  const [connected, setConnected] = useState(true)
  const [destination, setDestination] = useState('Engineering Design Centre')
  const [siriDestination, setSiriDestination] = useState<{ query: string }>()
  const scrollView = useRef<ComponentRef<typeof ScrollView>>(null)
  const routeY = useRef<number | null>(null)
  const [beltEnabled, setBeltEnabled] = useState(false)
  const [beltState, setBeltState] = useState('disconnected')
  const [coreML, setCoreML] = useState(false)
  const [fieldGuidance, setFieldGuidance] = useState(false)
  const [recording, setRecording] = useState(false)
  const [count, setCount] = useState(0)
  const [recordStatus, setRecordStatus] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [sharePoints, setSharePoints] = useState(false)
  const [streamStatus, setStreamStatus] = useState('')
  const realBelt = useRef(disconnected)
  const google = useRef<Route | null>(null)
  const latestFrame = useRef<Telemetry>(null)
  const recordingActive = useRef(false)
  const session = useRef<ReturnType<typeof createRecording>>(null)
  const lastRecorded = useRef(0)
  const onRoute = useCallback((route: Route | null) => { google.current = route }, [])

  useEffect(() => {
    if (!nativeDepth?.takeSiriDestination) return
    let active = true
    function readDestination() {
      void nativeDepth?.takeSiriDestination?.().then(query => {
        if (!active || !query) return
        setSiriDestination({ query })
        setNative(true)
        setStatus(current => current === 'idle' ? 'starting' : current)
      }).catch(() => {})
    }
    const listener = nativeDepth.addListener('onSiriDestination', readDestination)
    const appState = AppState.addEventListener('change', state => { if (state === 'active') readDestination() })
    readDestination()
    return () => { active = false; listener.remove(); appState.remove() }
  }, [])

  useEffect(() => {
    if (siriDestination && routeY.current !== null) scrollView.current?.scrollTo({ y: routeY.current })
  }, [siriDestination])

  useEffect(() => {
    if (!native || !beltEnabled || !nativeDepth) return
    const listener = nativeDepth.addListener('onBeltStatus', event => {
      realBelt.current = event
      setBeltState(event.state)
    })
    function reconnect() { setBeltState('scanning'); nativeDepth?.connectBelt() }
    function disconnect() {
      nativeDepth?.disconnectBelt()
      realBelt.current = disconnected
      setBeltState('disconnected')
    }
    if (AppState.currentState !== 'background' && AppState.currentState !== 'inactive') reconnect()
    const appState = AppState.addEventListener('change', state => state === 'active' ? reconnect() : disconnect())
    return () => { appState.remove(); listener.remove(); disconnect() }
  }, [native, beltEnabled])

  useEffect(() => {
    let latest = emptyObservation()
    let loop: ReturnType<typeof createLoop> | undefined
    let timer: ReturnType<typeof setInterval> | undefined
    const tick = () => {
      if (!loop) return
      const value = loop.tick()
      latestFrame.current = value
      setFrame(value)
      if (!recordingActive.current || !session.current) return
      const time = value.observation.timeMs
      if (time <= lastRecorded.current || (native ? !value.observation.depth : time - lastRecorded.current < 500)) return
      lastRecorded.current = time
      session.current.append(value)
      const size = session.current.count()
      setCount(size)
      if (size >= 240) stopRecording()
    }
    const onFrame = native ? nativeDepth?.addListener('onObservation', frame => {
      latest = frame
      tick()
    }) : undefined
    const onStatus = native ? nativeDepth?.addListener('onStatus', event => {
      setStatus(event.status)
      if (event.status !== 'running') latest = emptyObservation()
    }) : undefined
    function stop() {
      clearInterval(timer)
      loop?.stop()
      loop = undefined
      timer = undefined
      latest = emptyObservation()
      if (native) nativeDepth?.stop()
    }
    function start() {
      if (timer) return
      loop = createLoop({
        ...mock.providers,
        lidar: native ? () => latest : mock.providers.lidar,
        model: native ? grid => coreML ? nativeDepth?.predict(grid.cells) ?? Promise.resolve(null) : Promise.resolve(null)
          : mock.providers.model,
        navigation: native ? () => {
          const route = google.current
          if (!route) return { source: 'google', status: 'idle', destination: '', desiredHeading: null, maneuver: '' }
          const heading = latest.forwardTrueHeading
          const current = route.updatedAtMs && Date.now() - route.updatedAtMs < 3_000
          const desiredHeading = current && heading !== undefined && route.trueBearing !== undefined
            ? ((route.trueBearing - heading + 540) % 360) - 180 : null
          return { ...route, desiredHeading }
        } : mock.providers.navigation,
        belt: native && beltEnabled ? {
          status: () => realBelt.current,
          send: command => nativeDepth?.sendBelt(command.cue, command.motors),
        } : mock.providers.belt,
      }, fieldGuidance)
      if (native) nativeDepth?.start()
      tick()
      timer = setInterval(tick, 100)
    }
    if (AppState.currentState !== 'background' && AppState.currentState !== 'inactive') start()
    const appState = AppState.addEventListener('change', state => state === 'active' ? start() : stop())
    return () => {
      appState.remove()
      onFrame?.remove()
      onStatus?.remove()
      stop()
    }
  }, [mock, native, beltEnabled, coreML, fieldGuidance])

  useEffect(() => {
    if (!streaming || !native || !sharePoints) return
    nativeDepth?.previewDepth?.(true)
    return () => nativeDepth?.previewDepth?.(false)
  }, [streaming, native, sharePoints])

  useEffect(() => {
    if (!streaming || !telemetryUrl || !telemetryToken) return
    const endpoint = `${telemetryUrl.replace(/\/$/, '')}/api/telemetry`
    let request: AbortController | undefined
    let active = true
    let sentAt = 0
    const interval = setInterval(() => {
      const value = latestFrame.current
      if (request || !value || value.observation.timeMs <= sentAt || AppState.currentState === 'background') return
      sentAt = value.observation.timeMs
      request = new AbortController()
      const timeout = setTimeout(() => request?.abort(), 1_500)
      void fetch(endpoint, { method: 'POST', signal: request.signal,
        headers: { Authorization: `Bearer ${telemetryToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(telemetrySummary(value, native && sharePoints)),
      }).then(response => {
        if (active) setStreamStatus(response.ok ? 'Streaming to dashboard' : `Dashboard returned ${response.status}`)
      }, () => { if (active) setStreamStatus('Dashboard unreachable') }).finally(() => {
        clearTimeout(timeout)
        request = undefined
      })
    }, 330)
    return () => { active = false; clearInterval(interval); request?.abort() }
  }, [streaming, native, sharePoints])

  function stopRecording() {
    recordingActive.current = false
    nativeDepth?.recordDepth(false)
    setRecording(false)
  }

  function startRecording() {
    session.current = createRecording()
    recordingActive.current = true
    lastRecorded.current = 0
    setCount(0)
    setRecordStatus('')
    setRecording(true)
    if (native) nativeDepth?.recordDepth(true)
  }

  function setSensorMode(value: boolean) {
    stopRecording()
    latestFrame.current = null
    setFrame(undefined)
    setNative(value)
    if (!value) { setSiriDestination(undefined); routeY.current = null }
    setSharePoints(false)
    setFieldGuidance(false)
    setStatus(value ? 'starting' : 'idle')
  }

  const cue = frame?.command.cue
  const warning = cue === 'obstacle' ? 'Obstacle detected'
    : cue === 'unavailable' ? 'Depth unavailable'
    : frame?.heading != null ? `Local cue ${frame.heading}°` : 'Waiting for guidance'

  return (
    <ScrollView ref={scrollView} style={styles.page} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.titlebar}>
        <Text accessibilityRole="header" style={styles.title}>[+] Lantern</Text>
        <Text style={styles.muted}>{native ? 'ARKIT' : 'SIM'}</Text>
      </View>
      <Text accessible={false} aria-hidden style={styles.wordmark}>{LANTERN_BANNER}</Text>
      <View style={styles.toolbar}>
        <Control label="Simulation" selected={!native} onPress={() => { if (native) setSensorMode(false) }} />
        {nativeDepth && <Control label="iPhone LiDAR" selected={native} onPress={() => { if (!native) setSensorMode(true) }} />}
      </View>
      <View style={styles.panel}>
        <Text style={styles.kicker}>{native ? `[+] LiDAR / ${status}` : '[+] LiDAR'}</Text>
        <Text accessibilityLiveRegion="polite" style={[styles.heading, cue === 'obstacle' && styles.alert]}>{warning}</Text>
        {ZONE_NAMES.map((name, i) => (
          <View style={styles.zone} key={name}>
            <Text style={styles.muted}>{name}</Text>
            <Text style={styles.value}>{frame?.observation.zones[i]?.toFixed(2) ?? '—'} m</Text>
          </View>
        ))}
        {native && frame?.observation.source === 'arkit' && (
          <Text style={styles.muted}>
            {frame.observation.grid.cells.filter(cell => cell === 2).length} occupied grid cells
            {frame.observation.timeMs > 0 ? ` · ${Math.max(0, Math.round(Date.now() - frame.observation.timeMs))} ms frame age` : ''}
          </Text>
        )}
      </View>
      {!native && <View style={styles.row}>
        {(['walk', 'obstacle', 'dropout'] as const).map(value => (
          <Control key={value} label={value === 'walk' ? 'Walkway' : value === 'obstacle' ? 'Obstacle' : 'Dropout'}
            selected={scenario === value} onPress={() => { mock.setScenario(value); setScenario(value) }} />
        ))}
      </View>}
      {native && <View style={styles.panel} onLayout={event => {
        const y = event.nativeEvent.layout.y
        if (routeY.current === null && siriDestination) scrollView.current?.scrollTo({ y })
        routeY.current = y
      }}>
        <Text style={styles.kicker}>&gt; Google walking route</Text>
        <RouteCard route={frame?.route.source === 'google' ? frame.route : undefined} />
        <GoogleRoute onRoute={onRoute} siriDestination={status === 'idle' || status === 'starting' ? undefined : siriDestination} />
        <Control label="Enable direction cues" selected={fieldGuidance} onPress={() => setFieldGuidance(!fieldGuidance)} />
        <Control label="Enable Core ML" selected={coreML} onPress={() => setCoreML(!coreML)} />
        <Text style={styles.muted}>{frame?.prediction
          ? `${frame.prediction.version} · ${frame.prediction.latencyMs.toFixed(1)} ms`
          : coreML ? 'Core ML unavailable. Using clearance rules.' : 'Using clearance rules.'}</Text>
      </View>}
      {!native && <View style={styles.panel}>
        <Text style={styles.kicker}>&gt; Simulated route</Text>
        <TextInput accessibilityLabel="Simulated destination" style={styles.input} value={destination}
          onChangeText={setDestination} onSubmitEditing={() => mock.setDestination(destination)} returnKeyType="go" />
        <Control label="Set destination" onPress={() => mock.setDestination(destination)} />
        <RouteCard route={frame?.route.source === 'simulated' ? frame.route : undefined} />
      </View>}
      <View style={styles.panel}>
        <Text style={styles.kicker}>{native && beltEnabled ? `[#] Belt / ${beltState}` : '[#] Simulated belt'}</Text>
        {frame?.belt.battery != null && <Text style={styles.muted}>{frame.belt.battery}% battery</Text>}
        <View style={styles.row}>{ZONE_NAMES.map((name, i) => (
          <View key={name} accessibilityLabel={name} style={[styles.motor,
            frame?.belt.connected && (frame.command.motors[i] ?? 0) > 0 && (cue === 'obstacle' ? styles.motorAlert : styles.motorOn)]} />
        ))}</View>
        {native ? <Control label={beltEnabled ? 'Disconnect physical belt' : 'Scan for physical belt'}
          onPress={() => setBeltEnabled(!beltEnabled)} /> : <Control label={connected ? 'Disconnect belt' : 'Reconnect belt'} onPress={() => {
          mock.setConnected(!connected)
          setConnected(!connected)
        }} />}
      </View>
      <View style={styles.panel}>
        <Text style={styles.kicker}>&gt;_ Session data</Text>
        <Text style={styles.muted}>Recording keeps depth and pose on this device until you export. Up to 240 samples.</Text>
        <Control label={recording ? 'Stop recording' : 'Start recording'} onPress={recording ? stopRecording : startRecording} />
        <Text style={styles.muted}>{count} samples{recordStatus ? ` · ${recordStatus}` : ''}</Text>
        {!recording && count > 0 && <Control label="Export session" onPress={() => {
          void session.current?.share().catch(error => setRecordStatus(String(error)))
        }} />}
        {telemetryUrl && telemetryToken && <>
          <Control label={streaming ? 'Stop sharing' : 'Share with dashboard'}
            onPress={() => { setStreaming(!streaming); setSharePoints(false); setStreamStatus(streaming ? '' : 'Connecting…') }} />
          {streaming && native && nativeDepth?.previewDepth && <Control
            label={sharePoints ? 'Stop sharing 3D scan' : 'Share 3D scan with dashboard'}
            selected={sharePoints} onPress={() => setSharePoints(!sharePoints)} />}
          <Text style={styles.muted}>{streamStatus}</Text>
        </>}
      </View>
    </ScrollView>
  )
}

function Control({ label, selected, onPress }: { label: string; selected?: boolean; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress}
    style={[styles.button, selected && styles.selected]}><Text style={styles.value}>{label}</Text></Pressable>
}

const mono = Platform.OS === 'ios' ? 'Menlo' : 'monospace'

const styles = StyleSheet.create({
  page: { backgroundColor: '#090b0e' },
  content: { padding: 16, paddingTop: Platform.OS === 'web' ? 24 : 68, paddingBottom: 40, gap: 10,
    width: '100%', maxWidth: 560, alignSelf: 'center' },
  kicker: { color: '#9dd9e8', backgroundColor: '#151a1e', fontFamily: mono, fontSize: 12, fontWeight: '700',
    textTransform: 'uppercase', marginHorizontal: -12, marginTop: -12, padding: 8, borderBottomWidth: 1, borderColor: '#2c353b' },
  titlebar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: '#151a1e', borderWidth: 1, borderColor: '#2c353b', padding: 10 },
  title: { color: '#d7e9ed', fontFamily: mono, fontSize: 18, fontWeight: '700' },
  wordmark: { color: '#9dd9e8', fontFamily: mono, fontSize: 7, lineHeight: 7, paddingVertical: 4 },
  toolbar: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  heading: { color: '#d0f5ff', fontFamily: mono, fontSize: 20, fontWeight: '700' },
  alert: { color: '#ffc78e' },
  muted: { color: '#96acb9', fontFamily: mono, fontSize: 12 },
  value: { color: '#d5e3eb', fontFamily: mono, fontSize: 12, fontWeight: '600' },
  panel: { backgroundColor: '#0c1117', borderWidth: 1, borderColor: '#32404c', padding: 12, gap: 9 },
  row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  zone: { flexDirection: 'row', justifyContent: 'space-between' },
  button: { padding: 10, backgroundColor: '#0d141b', borderWidth: 1, borderColor: '#32404c' },
  selected: { backgroundColor: '#142a36', borderColor: '#8ce0f4' },
  input: { color: '#d5e3eb', fontFamily: mono, borderBottomWidth: 1, borderColor: '#32404c', paddingVertical: 10 },
  motor: { flex: 1, minWidth: 30, height: 16, borderWidth: 1, borderColor: '#32404c', backgroundColor: '#182430' },
  motorOn: { backgroundColor: '#8ce0f4' },
  motorAlert: { backgroundColor: '#ffc78e' },
})
