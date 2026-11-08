import { useCallback, useEffect, useRef, useState, type ComponentRef } from 'react'
import { AccessibilityInfo, AppState, Platform, Pressable, ScrollView, StatusBar, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native'
import { File } from 'expo-file-system'
import { shareAsync } from 'expo-sharing'
import { ZONE_NAMES, type BeltStatus, type DenseScan, type DepthPreview, type ModelPreview, type Route, type Telemetry } from '../shared/contracts'
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
const palette = { yellow: '#F8C200', blue: '#005299', red: '#E20004', cream: '#FFFDDE' }

function hasFreshRouteLocation(route: Route): boolean {
  const age = Date.now() - (route.updatedAtMs ?? 0)
  return age >= 0 && age < 3_000
}

export default function App() {
  const { width, fontScale } = useWindowDimensions()
  const scenarioColumns = width >= 380 && fontScale <= 1.15 ? 2 : 1
  const [mock] = useState(() => {
    const provider = createMock()
    provider.setDestination('')
    provider.setConnected(false)
    return provider
  })
  const [frame, setFrame] = useState<Telemetry>()
  const [scenario, setScenario] = useState<Scenario>('walk')
  const [native, setNative] = useState(Platform.OS === 'ios' && !!nativeDepth)
  const [screen, setScreen] = useState<'home' | 'settings' | 'advanced' | 'route'>('home')
  const scrollView = useRef<ComponentRef<typeof ScrollView>>(null)
  const screenHeading = useRef<ComponentRef<typeof Text>>(null)
  const previousScreen = useRef(screen)
  const [status, setStatus] = useState<DepthStatus>(native ? 'starting' : 'idle')
  const [connected, setConnected] = useState(false)
  const [destination, setDestination] = useState('Engineering Design Centre')
  const [siriDestination, setSiriDestination] = useState<{ query: string }>()
  const [routeActive, setRouteActive] = useState(false)
  const [endRequest, setEndRequest] = useState(0)
  const [beltEnabled, setBeltEnabled] = useState(false)
  const [beltState, setBeltState] = useState('disconnected')
  const [fieldGuidance, setFieldGuidance] = useState(true)
  const [recording, setRecording] = useState(false)
  const [count, setCount] = useState(0)
  const [recordStatus, setRecordStatus] = useState('')
  const [walkState, setWalkState] = useState<'idle' | 'starting' | 'recording' | 'finishing' | 'sharing'>('idle')
  const [walkCount, setWalkCount] = useState(0)
  const [walkURI, setWalkURI] = useState('')
  const [walkStatus, setWalkStatus] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [sharePoints, setSharePoints] = useState(false)
  const [previewModels, setPreviewModels] = useState(true)
  const [modelPreview, setModelPreview] = useState<ModelPreview>()
  const [modelProgress, setModelProgress] = useState('')
  const latestModelPreview = useRef<ModelPreview | undefined>(undefined)
  const latestDenseScan = useRef<{ denseScan: DenseScan; depthPreview?: DepthPreview; smoothedDepthPreview?: DepthPreview } | undefined>(undefined)
  const [streamStatus, setStreamStatus] = useState('')
  const realBelt = useRef(disconnected)
  const google = useRef<Route | null>(null)
  const latestFrame = useRef<Telemetry>(null)
  const recordingActive = useRef(false)
  const session = useRef<ReturnType<typeof createRecording>>(null)
  const lastRecorded = useRef(0)
  const onRoute = useCallback((route: Route | null) => {
    google.current = route
    const active = !!route && route.status !== 'idle'
    setRouteActive(active)
    if (active) setScreen(current => current === 'route' ? 'home' : current)
  }, [])

  useEffect(() => {
    if (previousScreen.current === screen) return
    previousScreen.current = screen
    scrollView.current?.scrollTo({ y: 0, animated: false })
    const frame = requestAnimationFrame(() => {
      if (screenHeading.current) AccessibilityInfo.sendAccessibilityEvent(screenHeading.current, 'focus')
    })
    return () => cancelAnimationFrame(frame)
  }, [screen])

  useEffect(() => {
    if (!nativeDepth?.takeSiriDestination) return
    let active = true
    function readDestination() {
      void nativeDepth?.takeSiriDestination?.().then(query => {
        if (!active || !query) return
        setSiriDestination({ query })
        setNative(true)
        if (!google.current) setScreen('route')
        setStatus(current => current === 'idle' ? 'starting' : current)
      }).catch(() => {})
    }
    const listener = nativeDepth.addListener('onSiriDestination', readDestination)
    const appState = AppState.addEventListener('change', state => { if (state === 'active') readDestination() })
    readDestination()
    return () => { active = false; listener.remove(); appState.remove() }
  }, [])

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
    const scan = nativeDepth?.hasDenseScan?.() ? nativeDepth.addListener('onDenseScan', ({ depthPreview, smoothedDepthPreview, ...denseScan }) => {
      latestDenseScan.current = { denseScan, depthPreview, smoothedDepthPreview }
    }) : undefined
    nativeDepth?.previewDepth?.(true)
    return () => {
      scan?.remove()
      latestDenseScan.current = undefined
      nativeDepth?.previewDepth?.(false)
    }
  }, [streaming, native, sharePoints])

  useEffect(() => {
    if (!native || !nativeDepth?.previewHazards) return
    nativeDepth.previewHazards(true)
    return () => nativeDepth?.previewHazards?.(false)
  }, [native])

  useEffect(() => {
    if (!native || !previewModels || !nativeDepth?.previewHazards) return
    const listener = nativeDepth.addListener('onHazardPreview', preview => {
      latestModelPreview.current = preview
      setModelPreview(preview)
    })
    const progress = nativeDepth.addListener('onHazardPreviewStatus', event => setModelProgress(event.message))
    return () => {
      listener.remove()
      progress.remove()
      latestModelPreview.current = undefined
      setModelPreview(undefined)
      setModelProgress('')
    }
  }, [native, previewModels])

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
      const scan = latestDenseScan.current
      const freshScan = scan && Math.abs(value.observation.timeMs - scan.denseScan.timeMs) < 900 ? scan : undefined
      request = new AbortController()
      const timeout = setTimeout(() => request?.abort(), 1_500)
      void fetch(endpoint, { method: 'POST', signal: request.signal,
        headers: { Authorization: `Bearer ${telemetryToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(telemetrySummary({
          ...value, modelPreview: native && previewModels ? latestModelPreview.current : undefined,
          observation: {
            ...value.observation,
            depthPreview: freshScan?.depthPreview ?? value.observation.depthPreview,
            smoothedDepthPreview: freshScan?.smoothedDepthPreview ?? value.observation.smoothedDepthPreview,
            denseScan: freshScan?.denseScan,
          },
        }, native && sharePoints)),
      }).then(response => {
        if (active) setStreamStatus(response.ok ? 'Streaming to dashboard' : `Dashboard returned ${response.status}`)
      }, () => { if (active) setStreamStatus('Dashboard unreachable') }).finally(() => {
        clearTimeout(timeout)
        request = undefined
      })
    }, 330)
    return () => { active = false; clearInterval(interval); request?.abort() }
  }, [streaming, native, sharePoints, previewModels])

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

  useEffect(() => {
    if (!nativeDepth?.startWalkRecording) return
    const listener = nativeDepth.addListener('onWalkFrame', ({ count }) => setWalkCount(count))
    return () => listener.remove()
  }, [])

  async function toggleWalkRecording() {
    if (!nativeDepth?.startWalkRecording || !nativeDepth.finishWalkRecording) return
    setWalkStatus('')
    if (walkState === 'recording') {
      setWalkState('finishing')
      try { setWalkURI(await nativeDepth.finishWalkRecording()) }
      catch (error) { setWalkStatus(String(error)) }
      finally { setWalkState('idle') }
    } else {
      setWalkState('starting')
      try {
        await nativeDepth.startWalkRecording()
        if (walkURI) {
          try { new File(walkURI).delete() } catch { /* Temporary files can be purged by iOS. */ }
        }
        setWalkURI('')
        setWalkCount(0)
        setWalkState('recording')
      } catch (error) {
        setWalkStatus(String(error))
        setWalkState('idle')
      }
    }
  }

  async function shareWalk() {
    setWalkState('sharing')
    setWalkStatus('')
    try { await shareAsync(walkURI, { mimeType: 'application/zip', UTI: 'public.zip-archive' }) }
    catch (error) { setWalkStatus(String(error)) }
    finally { setWalkState('idle') }
  }

  function setSensorMode(value: boolean) {
    stopRecording()
    latestFrame.current = null
    setFrame(undefined)
    setNative(value)
    if (!value) setSiriDestination(undefined)
    setSharePoints(false)
    setStatus(value ? 'starting' : 'idle')
  }

  const cue = frame?.command.cue
  const beltStatus = !beltEnabled ? 'Disconnected' : beltState === 'scanning' ? 'Searching for belt'
    : beltState === 'connected' ? 'Connected' : beltState === 'unavailable' ? 'Bluetooth or belt unavailable' : 'Disconnected'
  const hazardHold = frame?.heading === null && frame.baselineHeading != null &&
    frame.blockedHeadings?.includes(frame.baselineHeading)
  const modelWarning = frame?.modelWarning
  const warning = cue === 'obstacle' ? modelWarning === 'stairs' ? 'Stop. Possible stairs ahead.'
    : modelWarning === 'glass' ? 'Stop. Possible glass ahead.'
      : modelWarning === 'person' ? 'Stop. Person in your path.' : 'Stop. Obstacle ahead.'
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

  const stopWarning = cue === 'obstacle' || hazardHold
  const beltConnected = native ? beltState === 'connected' : connected
  const motors = frame?.command.motors ?? [0, 0, 0, 0, 0]
  // Match the firmware's five command channels to its three physical outputs.
  const buzzerLevels = [Math.max(motors[0], motors[1]), motors[2], Math.max(motors[3], motors[4])]
  const buzzerConnected = beltConnected && frame?.belt.connected
  const hasRoute = native ? routeActive : frame?.route.status === 'guiding'
  const depthReady = (!native || status === 'running') && frame && cue !== 'unavailable'
  const homeColor = stopWarning ? palette.red : beltConnected && depthReady ? palette.blue : palette.yellow
  const homeInk = homeColor === palette.yellow ? '#000' : '#fff'
  const homeStatus = stopWarning ? warning : direction ?? (
    !beltConnected ? native && beltEnabled ? beltStatus : 'Belt not connected'
    : !depthReady ? !frame || status === 'starting' ? 'Starting detection' : 'Depth unavailable'
    : hasRoute ? 'Waiting for direction' : 'Detection active')

  function toggleBelt() {
    if (native) setBeltEnabled(value => !value)
    else {
      mock.setConnected(!connected)
      setConnected(!connected)
    }
  }

  function routeAction() {
    if (!hasRoute) setScreen('route')
    else if (native) setEndRequest(value => value + 1)
    else mock.setDestination('')
  }

  return (
    <ScrollView ref={scrollView} style={[styles.page, screen === 'home' && { backgroundColor: homeColor }]}
      contentContainerStyle={[styles.content, screen === 'home' && styles.homeContent]}
      contentInsetAdjustmentBehavior="automatic" keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled">
      <StatusBar barStyle={screen === 'home' && homeColor === palette.yellow ? 'dark-content' : 'light-content'} />
      {screen === 'home' ? <>
        <View style={styles.homeHeader}>
          <Pressable accessibilityRole="button" onPress={() => setScreen('settings')} style={styles.settingsButton}>
            <Text style={[styles.settingsText, { color: homeInk }]}>Settings</Text>
          </Pressable>
        </View>
        <HomeButton label={native ? beltEnabled ? 'Disconnect Belt' : 'Connect Belt' : connected ? 'Disconnect Belt' : 'Connect Belt'}
          onPress={toggleBelt} largeText={fontScale > 1.15} />
        <View style={[styles.homeReadout, fontScale > 1.15 && styles.homeIntrinsic]}>
          <Text ref={screenHeading} accessible accessibilityRole="header"
            style={[styles.homeStatus, width < 360 && styles.homeStatusCompact, { color: homeInk }]}>{homeStatus}</Text>
        </View>
        <HomeButton label={hasRoute ? 'End Route' : 'Set Destination'} onPress={routeAction} largeText={fontScale > 1.15} />
      </> : <View style={styles.settings}>
        <Control label={screen === 'advanced' ? 'Back to Settings' : 'Back to Home'}
          onPress={() => setScreen(screen === 'advanced' ? 'settings' : 'home')} />
        <Text ref={screenHeading} accessible accessibilityRole="header" style={styles.kicker}>
          {screen === 'settings' ? 'Settings' : screen === 'advanced' ? 'Advanced' : 'Set destination'}
        </Text>
      </View>}
      {screen === 'settings' && <Control label="Advanced" onPress={() => setScreen('advanced')} />}
      {native && <View key="google-route" style={screen === 'route' ? styles.panel : styles.hidden}>
        <GoogleRoute onRoute={onRoute} visible={screen === 'route'} endRequest={endRequest}
          siriDestination={status === 'idle' || status === 'starting' ? undefined : siriDestination} />
      </View>}
      {screen === 'route' && !native && <View style={styles.panel}>
        <TextInput accessibilityLabel="Simulated destination" style={styles.input} value={destination}
          onChangeText={setDestination} onSubmitEditing={() => {
            if (destination.trim()) { mock.setDestination(destination); setScreen('home') }
          }} returnKeyType="go" />
        <Control label="Start simulated route" disabled={!destination.trim()}
          onPress={() => { mock.setDestination(destination); setScreen('home') }} />
      </View>}
      {screen === 'advanced' && <>
      <View style={styles.banner}>
        <Text accessible accessibilityRole="header" accessibilityLabel="Lantern"
          allowFontScaling={false} style={styles.wordmark}>{LANTERN_BANNER}</Text>
      </View>
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
      {native && <View style={styles.panel}>
        <Text accessibilityRole="header" style={styles.kicker}>Walking directions</Text>
        <RouteCard route={frame?.route.source === 'google' ? frame.route : undefined} />
      </View>}
      <View style={styles.panel}>
        <Text accessibilityRole="header" style={styles.kicker}>Sensor readings</Text>
        <Text accessibilityRole="header" style={styles.readoutLabel}>{native ? 'Buzzer commands' : 'Simulated buzzer commands'}</Text>
        {!buzzerConnected && <Text style={styles.muted}>Belt not connected</Text>}
        <View style={styles.row}>{['Left', 'Front', 'Right'].map((name, i) => {
          const active = buzzerConnected && (cue === 'direction' || cue === 'obstacle') && buzzerLevels[i] > 0
          const state = active ? cue === 'obstacle' ? 'Warning' : 'Active' : 'Off'
          return <View key={name} accessible accessibilityLabel={`${name} buzzer, ${state}`}
            style={[styles.buzzer, active && (cue === 'obstacle' ? styles.motorAlert : styles.motorOn)]}>
            <Text style={[styles.buzzerLabel, active && styles.buzzerActiveText]}>{name}</Text>
            <Text style={[styles.buzzerState, active && styles.buzzerActiveText]}>{state}</Text>
          </View>
        })}</View>
        <Text accessibilityRole="header" style={styles.readoutLabel}>LiDAR distance</Text>
        {ZONE_NAMES.map((name, i) => <View style={styles.zone} key={name}>
          <Text style={styles.muted}>{name}</Text>
          <Text style={styles.value}>{frame?.observation.zones[i]?.toFixed(2) ?? '—'} m</Text>
        </View>)}
        {native && <>
          {nativeDepth?.previewHazards && <SettingSwitch label="Preview hazard models"
            hint="Shows model details and enables preview sharing."
            value={previewModels} onChange={setPreviewModels} />}
          {previewModels && nativeDepth?.previewHazards && <Text style={styles.muted}>{modelPreview
            ? `Glass: ${modelPreview.models.glass}. Stairs: ${modelPreview.models.stairs}. People: ${modelPreview.models.person}.`
            : status !== 'running' ? `Waiting for iPhone LiDAR (${status}).`
              : modelProgress ? `${modelProgress}…` : 'Waiting for the first model result from the iPhone.'}</Text>}
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
        {nativeDepth?.startWalkRecording && (native || walkState !== 'idle' || !!walkURI) && <>
          <Text accessibilityRole="header" style={styles.kicker}>ML recording</Text>
          <Text style={styles.muted}>Saves camera images, depth, pose, and model results on this iPhone. Share only walks you have consent to collect. Up to 120 frames.</Text>
          <Control label={walkState === 'recording' ? 'Stop ML recording' : walkState === 'finishing' ? 'Preparing export…' : 'Start ML recording'}
            disabled={walkState !== 'recording' && (walkState !== 'idle' || status !== 'running' || !native)}
            onPress={() => { void toggleWalkRecording() }} />
          <Text style={styles.muted}>{walkCount} frames{walkCount >= 120 && walkState === 'recording' ? ' · Limit reached. Stop to export.' : ''}{walkStatus ? ` · ${walkStatus}` : ''}</Text>
          {walkURI && <Control label="Share ML recording ZIP" disabled={walkState !== 'idle'} onPress={() => { void shareWalk() }} />}
        </>}
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
      {nativeDepth && !native && <Control label="Use iPhone LiDAR" primary onPress={() => setSensorMode(true)} />}
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
      {native && <Control label="Switch to simulation" onPress={() => setSensorMode(false)} />}
      </>}
    </ScrollView>
  )
}

function HomeButton({ label, onPress, largeText }: { label: string; onPress: () => void; largeText: boolean }) {
  return <Pressable accessibilityRole="button" onPress={onPress}
    style={({ pressed }) => [styles.homeButton, largeText && styles.homeIntrinsic, pressed && styles.homeButtonPressed]}>
    <Text style={styles.homeButtonText}>{label}</Text>
  </Pressable>
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
  hidden: { display: 'none' },
  homeContent: { flexGrow: 1, paddingHorizontal: 28, paddingBottom: 24, gap: 12 },
  homeHeader: { alignItems: 'flex-end' },
  settingsButton: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 10 },
  settingsText: { fontSize: 18, fontWeight: '700' },
  homeButton: { flexGrow: 1, flexBasis: 0, minHeight: 104, backgroundColor: palette.cream, borderWidth: 3,
    borderColor: '#000', borderRadius: 28, justifyContent: 'center', padding: 16 },
  homeButtonPressed: { opacity: 0.82 },
  homeButtonText: { color: '#000', fontSize: 36, fontWeight: '800', textAlign: 'center' },
  homeReadout: { flexGrow: 1, flexBasis: 0, minHeight: 144, justifyContent: 'center', paddingVertical: 12 },
  homeIntrinsic: { flexBasis: 'auto' },
  homeStatus: { fontSize: 36, fontWeight: '800', textAlign: 'center' },
  homeStatusCompact: { fontSize: 30 },
  alertPanel: { backgroundColor: '#342418' },
  row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  scenarioList: { gap: 8 },
  scenarioRow: { flexDirection: 'row', gap: 8, alignItems: 'stretch' },
  scenarioCell: { flex: 1, minWidth: 0 },
  zone: { flexDirection: 'row', justifyContent: 'space-between' },
  input: { color: terminal.text, fontSize: 18, minHeight: 56, borderWidth: 1, borderColor: terminal.border,
    borderRadius: 12, backgroundColor: terminal.background, paddingHorizontal: 14, paddingVertical: 12 },
  buzzer: { flex: 1, minWidth: 78, padding: 8, borderRadius: 8, borderWidth: 1, borderColor: '#32404c', backgroundColor: '#182430' },
  buzzerLabel: { color: terminal.text, fontSize: 17, fontWeight: '700', textAlign: 'center' },
  buzzerState: { color: terminal.muted, fontSize: 15, textAlign: 'center' },
  buzzerActiveText: { color: '#111' },
  motorOn: { backgroundColor: '#8ce0f4' },
  motorAlert: { backgroundColor: '#ffc78e' },
})
