import { useCallback, useEffect, useRef, useState, type ComponentRef } from 'react'
import { AccessibilityInfo, AppState, Platform, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native'
import { ZONE_NAMES, type BeltStatus, type Route, type Telemetry } from '../shared/contracts'
import { createLoop } from '../shared/guidance'
import { LANTERN_BANNER } from '../shared/lantern'
import { createMock, emptyObservation, scenarios, type Scenario } from '../shared/mock'
import { nativeDepth, type DepthStatus } from './nativeDepth'
import GoogleRoute from './GoogleRoute'
import { RouteCard } from './RouteCard'
import { ActionButton as Control } from './ActionButton'
import { SettingSwitch } from './SettingSwitch'
import { mono, terminal } from './terminal'
import { createRecording, telemetrySummary } from './session'

const telemetryUrl = process.env.EXPO_PUBLIC_TELEMETRY_URL
const telemetryToken = process.env.EXPO_PUBLIC_TELEMETRY_TOKEN
const disconnected: BeltStatus = { connected: false, battery: null, source: 'ble' }
const beltDirections = ['Turn farther left', 'Veer left', 'Go straight', 'Veer right', 'Turn farther right']
const scenarioChoices = Object.keys(scenarios) as Scenario[]

function hasFreshRouteLocation(route: Route): boolean {
  const age = Date.now() - (route.updatedAtMs ?? 0)
  return age >= 0 && age < 3_000
}

export default function App() {
  const { width, fontScale } = useWindowDimensions()
  const scenarioColumns = width >= 380 && fontScale <= 1.15 ? 2 : 1
  const [mock] = useState(createMock)
  const [frame, setFrame] = useState<Telemetry>()
  const [scenario, setScenario] = useState<Scenario>('walk')
  const [native, setNative] = useState(false)
  const [showTools, setShowTools] = useState(false)
  const [status, setStatus] = useState<DepthStatus>('idle')
  const [connected, setConnected] = useState(true)
  const [destination, setDestination] = useState('Engineering Design Centre')
  const [siriDestination, setSiriDestination] = useState<{ query: string }>()
  const scrollView = useRef<ComponentRef<typeof ScrollView>>(null)
  const routeY = useRef<number | null>(null)
  const [beltEnabled, setBeltEnabled] = useState(false)
  const [beltState, setBeltState] = useState('disconnected')
  const [fieldGuidance, setFieldGuidance] = useState(true)
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
        navigation: native ? () => {
          const route = google.current
          if (!route) return { source: 'google', status: 'idle', destination: '', desiredHeading: null, maneuver: '' }
          const heading = latest.forwardTrueHeading
          const desiredHeading = hasFreshRouteLocation(route) && heading !== undefined && route.trueBearing !== undefined
            ? ((route.trueBearing - heading + 540) % 360) - 180 : null
          return { ...route, desiredHeading }
        } : mock.providers.navigation,
        belt: native ? {
          status: () => beltEnabled ? realBelt.current : disconnected,
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
  }, [mock, native, beltEnabled, fieldGuidance])

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
    setStatus(value ? 'starting' : 'idle')
  }

  const cue = frame?.command.cue
  const beltStatus = !beltEnabled ? 'Disconnected' : beltState === 'scanning' ? 'Searching for belt'
    : beltState === 'connected' ? 'Connected' : beltState === 'unavailable' ? 'Bluetooth or belt unavailable' : 'Disconnected'
  const hazardHold = frame?.heading === null && frame.baselineHeading != null &&
    frame.blockedHeadings?.includes(frame.baselineHeading)
  const warning = cue === 'obstacle' ? 'Stop. Obstacle ahead.'
    : hazardHold ? 'Caution. A hazard blocks guidance.'
    : cue === 'unavailable' ? 'LiDAR cannot verify clearance.' : null
  const motor = frame?.command.motors.findIndex(strength => strength > 0) ?? -1
  const direction = cue === 'direction' ? beltDirections[motor] : undefined
  const guidanceStatus = direction ?? warning ?? (
    !frame ? 'Waiting for sensor data'
      : native && !fieldGuidance ? 'Direction cues are off'
      : frame.route.status === 'idle' ? 'Start a walk'
      : frame.route.status === 'rerouting' ? 'Waiting for Google to update the route'
      : native && !hasFreshRouteLocation(frame.route) ? 'Waiting for a fresh Google location. Try outdoors.'
      : native && frame.route.trueBearing === undefined ? 'Google has no route direction at this location'
      : native && frame.observation.forwardTrueHeading === undefined ? 'Phone heading unavailable. Hold the rear camera facing forward.'
      : 'No clear direction toward the route'
  )

  useEffect(() => {
    if (warning) AccessibilityInfo.announceForAccessibility(warning)
  }, [warning])

  useEffect(() => {
    if (native && beltEnabled && beltState !== 'disconnected') {
      AccessibilityInfo.announceForAccessibility(beltState === 'connected' ? 'Belt connected' : beltStatus)
    }
  }, [native, beltEnabled, beltState, beltStatus])

  return (
    <ScrollView ref={scrollView} style={styles.page} contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic" keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled">
      <View style={styles.banner}>
        <Text accessible accessibilityRole="header" accessibilityLabel="Lantern"
          allowFontScaling={false} style={styles.wordmark}>{LANTERN_BANNER}</Text>
      </View>
      {nativeDepth && !native && <Control label="Use iPhone LiDAR" primary onPress={() => setSensorMode(true)} />}
      {native && <View style={styles.panel}>
        <Text accessibilityRole="header" style={styles.kicker}>Belt</Text>
        <Text style={styles.status}>{beltStatus}{frame?.belt.battery != null ? ` · ${frame.belt.battery}% battery` : ''}</Text>
        <Control primary={!beltEnabled} label={beltEnabled ? 'Disconnect belt' : 'Connect belt'}
          hint={beltEnabled ? 'Stops belt cues' : 'Searches for your belt over Bluetooth'} onPress={() => {
          setBeltEnabled(!beltEnabled)
        }} />
        <SettingSwitch label="Direction cues" value={fieldGuidance} onChange={setFieldGuidance}
          hint="Obstacle warnings stay active while the belt is connected" />
      </View>}
      <View style={[styles.panel, styles.readout, (cue === 'obstacle' || hazardHold) && styles.alertPanel]}>
        <Text accessibilityRole="header" style={styles.readoutLabel}>{native ? 'Belt guidance' : 'Simulated belt guidance'}</Text>
        <Text style={[styles.heading, (cue === 'obstacle' || hazardHold) && styles.alert]}>{guidanceStatus}</Text>
      </View>
      {!native && <View style={styles.panel}>
        <Text accessibilityRole="header" style={styles.kicker}>Scenario</Text>
        <View style={styles.scenarioList}>
          {Array.from({ length: Math.ceil(scenarioChoices.length / scenarioColumns) }, (_, row) => (
            <View key={row} style={styles.scenarioRow}>
              {scenarioChoices.slice(row * scenarioColumns, (row + 1) * scenarioColumns).map(value => (
                <View key={value} style={styles.scenarioCell}>
                  <Control label={scenarios[value]} selected={scenario === value} tile={scenarioColumns === 2}
                    onPress={() => { mock.setScenario(value); setScenario(value) }} />
                </View>
              ))}
            </View>
          ))}
        </View>
      </View>}
      {native && <View style={styles.panel} onLayout={event => {
        const y = event.nativeEvent.layout.y
        if (routeY.current === null && siriDestination) scrollView.current?.scrollTo({ y })
        routeY.current = y
      }}>
        <Text accessibilityRole="header" style={styles.kicker}>Walking directions</Text>
        <RouteCard route={frame?.route.source === 'google' ? frame.route : undefined} />
        <GoogleRoute onRoute={onRoute} siriDestination={status === 'idle' || status === 'starting' ? undefined : siriDestination} />
      </View>}
      {!native && <View style={styles.panel}>
        <Text accessibilityRole="header" style={styles.kicker}>Simulated route</Text>
        <TextInput accessibilityLabel="Simulated destination" style={styles.input} value={destination}
          onChangeText={setDestination} onSubmitEditing={() => mock.setDestination(destination)} returnKeyType="go" />
        <Control label="Set destination" onPress={() => mock.setDestination(destination)} />
        <RouteCard route={frame?.route.source === 'simulated' ? frame.route : undefined} />
      </View>}
      {!native && <View style={styles.panel}>
        <Text accessibilityRole="header" style={styles.kicker}>Simulated belt</Text>
        {frame?.belt.battery != null && <Text style={styles.muted}>{frame.belt.battery}% battery</Text>}
        <Control label={connected ? 'Disconnect belt' : 'Reconnect belt'} onPress={() => {
          mock.setConnected(!connected)
          setConnected(!connected)
        }} />
      </View>}
      <View style={styles.settings}>
        <Control label="Testing and data tools" expanded={showTools} onPress={() => setShowTools(!showTools)} />
        {native && <Control label="Switch to simulation" onPress={() => setSensorMode(false)} />}
      </View>
      {showTools && <>
      <View style={styles.panel}>
        <Text accessibilityRole="header" style={styles.kicker}>Sensor readings</Text>
        <View style={styles.row}>{ZONE_NAMES.map((name, i) => (
          <View key={name} accessible accessibilityLabel={`${name}: ${frame?.belt.connected && (frame.command.motors[i] ?? 0) > 0 ? 'cue active' : 'idle'}`} style={[styles.motor,
            frame?.belt.connected && (frame.command.motors[i] ?? 0) > 0 && (cue === 'obstacle' ? styles.motorAlert : styles.motorOn)]} />
        ))}</View>
        {ZONE_NAMES.map((name, i) => <View style={styles.zone} key={name}>
          <Text style={styles.muted}>{name}</Text>
          <Text style={styles.value}>{frame?.observation.zones[i]?.toFixed(2) ?? '—'} m</Text>
        </View>)}
        {native && <>
          <Text style={styles.muted}>{frame?.observation.hazards === undefined
            ? 'Clearance rules active. Hazard models unavailable.' : 'Clearance and hazard checks active.'}</Text>
        </>}
      </View>
      <View style={styles.panel}>
        <Text accessibilityRole="header" style={styles.kicker}>Session data</Text>
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
            hint={sharePoints ? undefined : 'Shares depth and sampled camera colors for the point cloud'}
            selected={sharePoints} onPress={() => setSharePoints(!sharePoints)} />}
          <Text style={styles.muted}>{streamStatus}</Text>
        </>}
      </View>
      </>}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  page: { backgroundColor: terminal.background },
  content: { padding: 20, paddingTop: Platform.OS === 'web' ? 28 : 16, paddingBottom: 32, gap: 16,
    width: '100%', maxWidth: 560, alignSelf: 'center' },
  kicker: { color: terminal.text, fontSize: 24, fontWeight: '700' },
  banner: { paddingVertical: 10, alignItems: 'flex-start' },
  wordmark: { color: terminal.accent, fontFamily: mono, fontSize: 7, lineHeight: 9 },
  heading: { color: terminal.text, fontSize: 22, fontWeight: '700' },
  alert: { color: '#ffc78e' },
  muted: { color: terminal.muted, fontSize: 17 },
  status: { color: terminal.muted, fontSize: 17 },
  value: { color: terminal.text, fontSize: 17, fontWeight: '600' },
  panel: { backgroundColor: terminal.surface, borderRadius: 20, padding: 16, gap: 12 },
  readout: { gap: 4 },
  readoutLabel: { color: terminal.muted, fontSize: 16, fontWeight: '600' },
  settings: { gap: 8 },
  alertPanel: { backgroundColor: '#342418' },
  row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  scenarioList: { gap: 8 },
  scenarioRow: { flexDirection: 'row', gap: 8, alignItems: 'stretch' },
  scenarioCell: { flex: 1, minWidth: 0 },
  zone: { flexDirection: 'row', justifyContent: 'space-between' },
  input: { color: terminal.text, fontSize: 18, minHeight: 56, borderWidth: 1, borderColor: terminal.border,
    borderRadius: 12, backgroundColor: terminal.background, paddingHorizontal: 14, paddingVertical: 12 },
  motor: { flex: 1, minWidth: 30, height: 16, borderWidth: 1, borderColor: '#32404c', backgroundColor: '#182430' },
  motorOn: { backgroundColor: '#8ce0f4' },
  motorAlert: { backgroundColor: '#ffc78e' },
})
