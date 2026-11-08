import { useCallback, useEffect, useRef, useState, type ComponentRef } from 'react'
import { AccessibilityInfo, AppState, Keyboard, Platform, Pressable, SafeAreaView, ScrollView, StatusBar, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native'
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
import { walkUploads } from './walkUploads'
import type { UploadState } from '../shared/walkUploads'

const telemetryUrl = process.env.EXPO_PUBLIC_TELEMETRY_URL
const telemetryToken = process.env.EXPO_PUBLIC_TELEMETRY_TOKEN
const uploadUrl = process.env.EXPO_PUBLIC_ML_UPLOAD_URL
const uploadToken = process.env.EXPO_PUBLIC_ML_UPLOAD_TOKEN
const disconnected: BeltStatus = { connected: false, battery: null, source: 'ble' }
const beltDirections = ['Turn farther left', 'Veer left', 'Go straight', 'Veer right', 'Turn farther right']
const scenarioChoices = Object.keys(scenarios) as Scenario[]
const palette = { yellow: '#F8C200', blue: '#005299', red: '#E20004', cream: '#FFFDDE' }
const siriPrompt = 'Say “Hey Siri, navigate with Lantern,” or hold the side button and say “Navigate with Lantern.”'
const simulatedRoutePrompt = 'Set a simulated destination in Settings, then Advanced.'

function hasFreshRouteLocation(route: Route): boolean {
  const age = Date.now() - (route.updatedAtMs ?? 0)
  return age >= 0 && age < 3_000
}

export default function App() {
  const { width, height, fontScale } = useWindowDimensions()
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
  const [screen, setScreen] = useState<'home' | 'settings' | 'advanced' | 'route' | 'siri'>('home')
  const [showSiriPrompt, setShowSiriPrompt] = useState(false)
  const [voiceStatus, setVoiceStatus] = useState('')
  const [voiceListening, setVoiceListening] = useState(false)
  const voicePending = useRef(false)
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
  const [uploadState, setUploadState] = useState<UploadState>({ enabled: false, pending: 0, uploading: false, message: '' })
  const [uploader] = useState(() => walkUploads(uploadUrl, uploadToken, setUploadState))
  const [streaming, setStreaming] = useState(false)
  const [sharePoints, setSharePoints] = useState(false)
  const [previewModels, setPreviewModels] = useState(true)
  const [modelPreview, setModelPreview] = useState<ModelPreview>()
  const [modelProgress, setModelProgress] = useState('')
  const latestModelPreview = useRef<ModelPreview | undefined>(undefined)
  const latestCompletePreview = useRef<ModelPreview | undefined>(undefined)
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
    if (active) setScreen(current => current === 'route' || current === 'siri' ? 'home' : current)
  }, [])

  useEffect(() => {
    if (Platform.OS !== 'ios' || !nativeDepth?.finishWalkRecording) return
    try { uploader.start() } catch { setWalkStatus('Could not open the saved upload queue.') }
    const retry = () => { void uploader.retry() }
    const timer = setInterval(() => { if (AppState.currentState === 'active') retry() }, 30_000)
    const listener = AppState.addEventListener('change', state => { if (state === 'active') retry() })
    return () => { clearInterval(timer); listener.remove(); uploader.stop() }
  }, [uploader])

  useEffect(() => {
    if (previousScreen.current === screen) return
    if (previousScreen.current === 'route') Keyboard.dismiss()
    previousScreen.current = screen
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
        nativeDepth?.cancelDestinationListening?.()
        setSiriDestination({ query })
        setNative(true)
        setShowSiriPrompt(false)
        if (!google.current) setScreen('siri')
        setStatus(current => current === 'idle' ? 'starting' : current)
      }).catch(() => {})
    }
    const listener = nativeDepth.addListener('onSiriDestination', readDestination)
    const appState = AppState.addEventListener('change', state => { if (state === 'active') readDestination() })
    readDestination()
    return () => { active = false; listener.remove(); appState.remove() }
  }, [])

  useEffect(() => {
    if (!nativeDepth?.listenForDestination) return
    const listener = nativeDepth.addListener('onDestinationListening', () => setVoiceStatus('Listening for your destination…'))
    const appState = AppState.addEventListener('change', state => {
      if (state === 'background') nativeDepth?.cancelDestinationListening?.()
    })
    return () => { listener.remove(); appState.remove(); nativeDepth?.cancelDestinationListening?.() }
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
      if (!preview.partial) latestCompletePreview.current = preview
      setModelPreview(latestCompletePreview.current ?? preview)
    })
    const progress = nativeDepth.addListener('onHazardPreviewStatus', event => setModelProgress(event.message))
    return () => {
      listener.remove()
      progress.remove()
      latestModelPreview.current = undefined
      latestCompletePreview.current = undefined
      setModelPreview(undefined)
      setModelProgress('')
    }
  }, [native, previewModels])

  useEffect(() => {
    if (!streaming || !telemetryUrl || !telemetryToken) return
    const endpoint = `${telemetryUrl.replace(/\/$/, '')}/api/telemetry`
    const stream = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const headers = { Authorization: `Bearer ${telemetryToken}`, 'Content-Type': 'application/json', 'X-Lantern-Stream': stream }
    let request: AbortController | undefined
    let visualRequest: AbortController | undefined
    let active = true
    let sentAt = 0
    let visualKey = ''
    let sentPreviewKey = ''
    let sentCompletePreview: ModelPreview | undefined
    const interval = setInterval(() => {
      const value = latestFrame.current
      if (request || !value || value.observation.timeMs <= sentAt || AppState.currentState === 'background') return
      sentAt = value.observation.timeMs
      request = new AbortController()
      const timeout = setTimeout(() => request?.abort(), 1_500)
      void fetch(endpoint, { method: 'POST', signal: request.signal,
        headers,
        body: JSON.stringify(telemetrySummary(value)),
      }).then(response => {
        if (active) setStreamStatus(response.ok ? 'Streaming to dashboard' : `Dashboard returned ${response.status}`)
      }, () => { if (active) setStreamStatus('Dashboard unreachable') }).finally(() => {
        clearTimeout(timeout)
        request = undefined
      })
    }, 100)
    const visualInterval = setInterval(() => {
      const value = latestFrame.current
      if (!native || !sharePoints || visualRequest || !value || AppState.currentState === 'background') return
      const scan = latestDenseScan.current
      const freshScan = scan && Math.abs(value.observation.timeMs - scan.denseScan.timeMs) < 900 ? scan : undefined
      const complete = latestCompletePreview.current
      const pendingComplete = complete && complete !== sentCompletePreview ? complete : undefined
      const preview = previewModels ? pendingComplete ?? latestModelPreview.current : undefined
      const previewKey = preview ? `${preview.timeMs}/${preview.latencyMs}/${preview.partial}` : ''
      const reusePreview = previewKey !== '' && previewKey === sentPreviewKey
      const legacyScan = value.observation.points || value.observation.depthPreview ? value.observation.timeMs : ''
      const key = `${freshScan?.denseScan.timeMs ?? legacyScan}/${previewKey}/${JSON.stringify(value.observation.hazards ?? null)}`
      if (key === visualKey) return
      visualRequest = new AbortController()
      const timeout = setTimeout(() => visualRequest?.abort(), 3_000)
      void fetch(`${endpoint}/visuals`, { method: 'POST', signal: visualRequest.signal,
        headers: reusePreview ? { ...headers, 'X-Lantern-Reuse-Preview': '1' } : headers,
        body: JSON.stringify(telemetrySummary({
          ...value, modelPreview: reusePreview ? undefined : preview,
          observation: {
            ...value.observation,
            depthPreview: freshScan?.depthPreview ?? value.observation.depthPreview,
            smoothedDepthPreview: freshScan?.smoothedDepthPreview ?? value.observation.smoothedDepthPreview,
            denseScan: freshScan?.denseScan,
          },
        }, true)),
      }).then(response => {
        if (response.ok) {
          visualKey = key
          sentPreviewKey = previewKey
          if (preview && !preview.partial) sentCompletePreview = preview
        } else if (response.status === 409) {
          sentPreviewKey = ''
          sentCompletePreview = undefined
          visualKey = ''
        }
      }, () => {}).finally(() => {
        clearTimeout(timeout)
        visualRequest = undefined
      })
    }, 150)
    return () => {
      active = false
      clearInterval(interval)
      clearInterval(visualInterval)
      request?.abort()
      visualRequest?.abort()
    }
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
      try {
        const uri = await nativeDepth.finishWalkRecording()
        setWalkURI(uri)
        await uploader.enqueue(uri)
      }
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
      : frame.route.status === 'rerouting' ? 'Waiting for Google’s route'
      : native && !hasFreshRouteLocation(frame.route) ? 'Waiting for GPS. Try outdoors.'
      : native && frame.route.trueBearing === undefined ? 'Route direction unavailable'
      : native && frame.observation.forwardTrueHeading === undefined ? 'Hold the rear camera forward'
      : 'No clear path toward the route'
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
    hasRoute && frame?.route.status !== 'idle' ? guidanceStatus
    : !beltConnected ? native && beltEnabled ? beltStatus : 'Belt not connected'
    : !depthReady ? !frame || status === 'starting' ? 'Starting detection' : 'Depth unavailable'
    : 'Detection active')

  function toggleBelt() {
    if (native) setBeltEnabled(value => !value)
    else {
      mock.setConnected(!connected)
      setConnected(!connected)
    }
  }

  function routeAction() {
    if (screen === 'siri') setScreen('home')
    else if (!hasRoute && native) {
      if (voicePending.current) { nativeDepth?.cancelDestinationListening?.(); return }
      if (!nativeDepth?.listenForDestination) {
        setShowSiriPrompt(true)
        AccessibilityInfo.announceForAccessibility(siriPrompt)
        return
      }
      voicePending.current = true
      setVoiceListening(true)
      setShowSiriPrompt(false)
      setVoiceStatus('Opening microphone…')
      void nativeDepth.listenForDestination().then(query => {
        setVoiceStatus('')
        if (!query) return
        setSiriDestination({ query })
        setScreen('siri')
      }).catch(error => {
        const message = error instanceof Error ? error.message : 'Could not hear a destination.'
        setVoiceStatus(message)
        setShowSiriPrompt(true)
        AccessibilityInfo.announceForAccessibility(`${message} ${siriPrompt}`)
      }).finally(() => {
        voicePending.current = false
        setVoiceListening(false)
      })
    }
    else if (!hasRoute) {
      setShowSiriPrompt(true)
      AccessibilityInfo.announceForAccessibility(simulatedRoutePrompt)
    }
    else if (native) setEndRequest(value => value + 1)
    else mock.setDestination('')
  }

  const voiceRoute = screen === 'siri'
  const manualRoute = screen === 'route'
  const routeOpen = manualRoute || voiceRoute
  const homeLayout = screen === 'home' || voiceRoute
  const settingsLayout = screen === 'settings'
  const compactHome = width < 360 || height < 680

  return (
    <SafeAreaView style={[styles.page, homeLayout && { backgroundColor: homeColor }, settingsLayout && { backgroundColor: palette.blue }]}>
    <StatusBar barStyle={homeLayout && homeColor === palette.yellow ? 'dark-content' : 'light-content'} />
    <View style={[styles.content, styles.fixedContent, (homeLayout || settingsLayout) && styles.homeContent,
      screen === 'advanced' && styles.hidden]}>
      {manualRoute && <View style={styles.settings}>
        <Control label="Back to Advanced" onPress={() => setScreen('advanced')} />
        <Text ref={screenHeading} accessible accessibilityRole="header" style={styles.kicker}>
          Enter destination
        </Text>
      </View>}
      {homeLayout && <HomeButton label={native ? beltEnabled ? 'Disconnect Belt' : 'Connect Belt' : connected ? 'Disconnect Belt' : 'Connect Belt'}
        onPress={toggleBelt} compact={compactHome} />}
      <View style={homeLayout ? styles.homeReadout
        : manualRoute ? [styles.panel, styles.fixedContent] : styles.hidden}>
          {homeLayout && <Text ref={voiceRoute ? undefined : screenHeading} accessible accessibilityRole="header"
            adjustsFontSizeToFit numberOfLines={3}
            style={[styles.homeStatus, compactHome && styles.homeStatusCompact, voiceRoute && styles.routeStatus, { color: homeInk }]}>{homeStatus}</Text>}
          {screen === 'home' && showSiriPrompt && !hasRoute &&
            <Text adjustsFontSizeToFit numberOfLines={5}
              style={[styles.siriPrompt, { color: homeInk }]}>{native ? siriPrompt : simulatedRoutePrompt}</Text>}
          {screen === 'home' && voiceStatus
            ? <Text adjustsFontSizeToFit numberOfLines={3} style={[styles.siriPrompt, { color: homeInk }]}>{voiceStatus}</Text>
            : null}
          {screen === 'home' && <View style={styles.homeSettings}>
            <Pressable accessibilityRole="button" accessibilityLabel="Settings"
              accessibilityActions={[{ name: 'activate' }]}
              onAccessibilityAction={event => {
                if (event.nativeEvent.actionName === 'activate') setScreen('settings')
              }}
              onAccessibilityTap={() => setScreen('settings')}
              onPress={Platform.OS === 'web' ? () => setScreen('settings') : undefined}
              delayLongPress={650} onLongPress={() => setScreen('settings')} style={styles.settingsButton}>
              <Text style={[styles.settingsText, { color: homeInk }]}>
                {Platform.OS === 'web' ? 'Settings' : 'Hold for Settings'}
              </Text>
            </Pressable>
          </View>}
          <ScrollView style={voiceRoute ? styles.routeEditor : manualRoute ? styles.scroll : styles.hidden}
            automaticallyAdjustKeyboardInsets={manualRoute} keyboardDismissMode="on-drag"
            keyboardShouldPersistTaps="handled" contentContainerStyle={styles.routeEditorContent}>
            {voiceRoute && <Text ref={screenHeading} accessible accessibilityRole="header" style={styles.routeHeading}>Spoken destination</Text>}
            {native && <GoogleRoute onRoute={onRoute} visible={routeOpen} voiceOnly={voiceRoute} endRequest={endRequest}
              siriDestination={status === 'idle' || status === 'starting' ? undefined : siriDestination} />}
          </ScrollView>
      </View>
      {homeLayout && <HomeButton label={voiceRoute ? 'Close Results' : hasRoute ? 'End Route'
        : voiceListening ? 'Cancel Listening' : native ? 'Speak Destination' : 'Set Destination'}
        hint={native && !voiceRoute && !hasRoute && !voiceListening
          ? nativeDepth?.listenForDestination ? 'Wait for the vibration, then say a place or address.' : 'Hear how to set a destination with Siri.'
          : undefined}
        onPress={routeAction} compact={compactHome} />}
      {settingsLayout && <>
        <HomeButton label="Back to Home" onPress={() => setScreen('home')} compact={compactHome} />
        <View style={styles.homeReadout}>
          <Text ref={screenHeading} accessible accessibilityRole="header" adjustsFontSizeToFit numberOfLines={2}
            style={[styles.homeStatus, compactHome && styles.homeStatusCompact, styles.settingsHeading]}>Settings</Text>
        </View>
        <HomeButton label="Advanced" onPress={() => setScreen('advanced')} compact={compactHome} />
      </>}
    </View>
    {screen === 'advanced' && <ScrollView style={styles.scroll} contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="never" keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets>
      <View style={styles.banner}>
        <Text ref={screenHeading} accessible accessibilityRole="header" accessibilityLabel="Lantern"
          allowFontScaling={false} style={styles.wordmark}>{LANTERN_BANNER}</Text>
      </View>
      <Control label="Back to Home" onPress={() => setScreen('home')} />
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
        {!hasRoute && <Control label="Enter destination or change Siri options" onPress={() => setScreen('route')} />}
      </View>}
      <View style={styles.panel}>
        <Text accessibilityRole="header" style={styles.kicker}>Sensor readings</Text>
        <Text accessibilityRole="header" style={styles.readoutLabel}>{native ? 'Buzzer commands' : 'Simulated buzzer commands'}</Text>
        {!buzzerConnected && <Text style={styles.muted}>Belt disconnected. Showing intended commands.</Text>}
        <View style={styles.row}>{['Left', 'Front', 'Right'].map((name, i) => {
          const active = (cue === 'direction' || cue === 'obstacle') && buzzerLevels[i] > 0
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
          <SettingSwitch label="Upload ML recordings automatically"
            hint="Opt in to send recorded camera images, depth and model results to Lantern's Databricks storage. Failed uploads stay on this iPhone for retry."
            value={uploadState.enabled} onChange={value => {
              if (value && (!uploadUrl || !uploadToken)) { setWalkStatus('An HTTPS ML upload server must be configured first.'); return }
              try { uploader.setEnabled(value) } catch { setWalkStatus('Could not save the upload setting.') }
            }} />
          <Text style={styles.muted}>{uploadState.pending} ML uploads pending. {uploadState.message}</Text>
          {uploadState.enabled && uploadState.pending > 0 && <Control label="Retry ML uploads" disabled={uploadState.uploading}
            onPress={() => { void uploader.retry() }} />}
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
    </ScrollView>}
    </SafeAreaView>
  )
}

function HomeButton({ label, hint, onPress, compact }: { label: string; hint?: string; onPress: () => void; compact: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityHint={hint} onPress={onPress}
    style={({ pressed }) => [styles.homeButton, pressed && styles.homeButtonPressed]}>
    <Text adjustsFontSizeToFit numberOfLines={2}
      style={[styles.homeButtonText, compact && styles.homeStatusCompact]}>{label}</Text>
  </Pressable>
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: terminal.background },
  scroll: { flex: 1 },
  fixedContent: { flex: 1, minHeight: 0 },
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
  homeContent: { flex: 1, paddingHorizontal: 20, paddingVertical: 10, gap: 8 },
  homeSettings: { alignItems: 'center' },
  settingsButton: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 10 },
  settingsText: { fontSize: 18, fontWeight: '700' },
  settingsHeading: { color: '#fff' },
  homeButton: { height: '26%', minHeight: 56, backgroundColor: palette.cream, borderWidth: 3,
    borderColor: '#000', borderRadius: 28, justifyContent: 'center', padding: 10 },
  homeButtonPressed: { opacity: 0.82 },
  homeButtonText: { color: '#000', fontSize: 36, fontWeight: '800', textAlign: 'center' },
  homeReadout: { flex: 1, minHeight: 0, justifyContent: 'center' },
  homeStatus: { flexShrink: 1, fontSize: 36, fontWeight: '800', textAlign: 'center' },
  homeStatusCompact: { fontSize: 30 },
  routeStatus: { fontSize: 22, marginBottom: 8 },
  routeEditor: { flex: 1, minHeight: 0, backgroundColor: terminal.surface, borderRadius: 14 },
  routeEditorContent: { padding: 12, gap: 10 },
  routeHeading: { color: terminal.text, fontSize: 20, fontWeight: '700' },
  siriPrompt: { flexShrink: 1, fontSize: 16, textAlign: 'center', marginTop: 8 },
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
