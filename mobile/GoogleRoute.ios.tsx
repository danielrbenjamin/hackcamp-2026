import { useCallback, useEffect, useEffectEvent, useRef, useState, type ComponentRef } from 'react'
import { AccessibilityInfo, Keyboard, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { requestForegroundPermissionsAsync } from 'expo-location'
import { AudioGuidanceMode, NavigationProvider, NavigationSessionStatus, NavState, RouteStatus, TravelMode, useNavigation } from '@googlemaps/react-native-navigation-sdk'
import { routeBearing, type Coordinate } from '../shared/geo'
import type { Route } from '../shared/contracts'
import type { GoogleRouteProps } from './GoogleRoute'
import { nativeDepth, type PlaceSuggestion } from './nativeDepth'
import { ActionButton } from './ActionButton'
import { SettingSwitch } from './SettingSwitch'
import { terminal } from './terminal'

const termsOptions = { title: 'Lantern', companyName: 'Lantern' }

export default function GoogleRoute(props: GoogleRouteProps) {
  if (!nativeDepth?.hasGoogleNavigation()) {
    if (!props.visible) return null
    return <Text style={{ color: '#aab9c9' }}>Build with GOOGLE_MAPS_IOS_API_KEY to enable Google walking routes.</Text>
  }
  return <NavigationProvider termsAndConditionsDialogOptions={termsOptions}>
    <WalkingRoute {...props} />
  </NavigationProvider>
}

function WalkingRoute({ onRoute, siriDestination, visible, voiceOnly, endRequest }: GoogleRouteProps) {
  const {
    navigationController: controller, setOnLocationChanged, setOnRouteChanged,
    setOnReroutingRequestedByOffRoute, setOnTurnByTurn, setOnArrival,
  } = useNavigation()
  const [destination, setDestination] = useState('')
  const [status, setStatus] = useState('')
  const [manual, setManual] = useState(!nativeDepth?.searchPlaces)
  const [selected, setSelected] = useState<PlaceSuggestion | null>(null)
  const [selectedFromSiri, setSelectedFromSiri] = useState(false)
  const startButton = useRef<ComponentRef<typeof Pressable>>(null)
  const focusStart = useRef(false)
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([])
  const [searchStatus, setSearchStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [showOptions, setShowOptions] = useState(false)
  const [spokenDirections, setSpokenDirections] = useState(false)
  const [announceStart, setAnnounceStart] = useState(false)
  const working = useRef(false)
  const [guiding, setGuiding] = useState(false)
  const [initialized, setInitialized] = useState(false)
  const [locationReady, setLocationReady] = useState(false)
  const [autoStart, setAutoStart] = useState(() => nativeDepth?.getSiriAutoStart?.() ?? false)
  const [spokenSearch, setSpokenSearch] = useState<GoogleRouteProps['siriDestination']>()
  const [autoPlace, setAutoPlace] = useState<PlaceSuggestion | null>(null)
  const handledSiri = useRef<GoogleRouteProps['siriDestination']>(undefined)
  const handledEnd = useRef(endRequest)
  const session = useRef({ initialized: false, active: false, alive: true, request: 0, location: null as Coordinate | null,
    locationAtMs: 0, path: [] as Coordinate[], destination: '', maneuver: '', rerouting: false })

  useEffect(() => {
    if (!selected || !focusStart.current) return
    focusStart.current = false
    const frame = requestAnimationFrame(() => {
      if (startButton.current) AccessibilityInfo.sendAccessibilityEvent(startButton.current, 'focus')
    })
    return () => cancelAnimationFrame(frame)
  }, [selected])

  useEffect(() => {
    if (status) AccessibilityInfo.announceForAccessibility(status)
  }, [status])

  const suggestionCount = suggestions.length
  useEffect(() => {
    if (spokenSearch && autoStart) return
    if (suggestionCount) {
      AccessibilityInfo.announceForAccessibility(`${suggestionCount} destination ${suggestionCount === 1 ? 'result' : 'results'} available`)
    } else if (searchStatus && searchStatus !== 'Searching…') {
      AccessibilityInfo.announceForAccessibility(searchStatus)
    }
  }, [suggestionCount, searchStatus, spokenSearch, autoStart])

  useEffect(() => {
    const query = destination.trim()
    if (!initialized || manual || guiding || selected || query.length < (spokenSearch ? 1 : 3) || !nativeDepth?.searchPlaces) return
    if (spokenSearch && autoStart && !locationReady && nativeDepth.searchPlacesNear) {
      setSearchStatus('Waiting for your location…')
      return
    }
    let active = true
    const timer = setTimeout(async () => {
      try {
        const { location, locationAtMs } = session.current
        const matches = await (location && Date.now() - locationAtMs < 60_000 && nativeDepth?.searchPlacesNear
          ? nativeDepth.searchPlacesNear(query, location.lat, location.lng)
          : nativeDepth?.searchPlaces?.(query)) ?? []
        if (!active) return
        setSuggestions(matches)
        setAutoPlace(spokenSearch && autoStart ? matches[0] ?? null : null)
        setSearchStatus(matches.length ? '' : 'No places found.')
      } catch {
        if (active) setSearchStatus('Place search unavailable. Check your connection and Places API setup.')
      }
    }, 300)
    return () => { active = false; clearTimeout(timer) }
  }, [destination, initialized, manual, guiding, selected, spokenSearch, autoStart, locationReady])

  const receiveSiri = useEffectEvent((request: NonNullable<GoogleRouteProps['siriDestination']>) => {
    editDestination(request.query)
    setManual(false)
    setSpokenSearch(request)
    setSearchStatus('Searching…')
    if (!initialized) void connect()
  })

  useEffect(() => {
    if (!siriDestination || siriDestination === handledSiri.current || busy) return
    handledSiri.current = siriDestination
    if (guiding) setStatus('Stop the current route before requesting another Siri destination.')
    else receiveSiri(siriDestination)
  }, [siriDestination, guiding, busy])

  const startSiriRoute = useEffectEvent((place: PlaceSuggestion) => {
    setAutoPlace(null)
    selectPlace(place, true)
    void start(place, true)
  })

  useEffect(() => {
    if (autoStart && autoPlace && locationReady && !busy && !guiding) startSiriRoute(autoPlace)
  }, [autoStart, autoPlace, locationReady, busy, guiding])

  function editDestination(value: string) {
    setDestination(value)
    setSelected(null)
    setSelectedFromSiri(false)
    setSuggestions([])
    setSpokenSearch(undefined)
    setAutoPlace(null)
    setSearchStatus(!manual && value.trim().length >= 3 ? 'Searching…' : '')
  }

  function selectPlace(place: PlaceSuggestion, fromSiri = Boolean(spokenSearch)) {
    setSelected(place)
    setSelectedFromSiri(fromSiri)
    setDestination(place.label)
    setSuggestions([])
    setSearchStatus('')
    setSpokenSearch(undefined)
    setAutoPlace(null)
    Keyboard.dismiss()
  }

  const publishRoute = useCallback(() => {
    const state = session.current
    if (!state.active) return
    const bearing = state.location && !state.rerouting ? routeBearing(state.location, state.path) : null
    onRoute({ source: 'google', status: state.rerouting ? 'rerouting' : 'guiding',
      destination: state.destination, maneuver: state.maneuver, desiredHeading: null,
      trueBearing: bearing ?? undefined, updatedAtMs: state.locationAtMs })
  }, [onRoute])

  const refreshRoute = useCallback(async () => {
    const state = session.current
    const request = ++state.request
    try {
      const segment = await controller.getCurrentRouteSegment()
      if (!state.active || request !== state.request) return
      state.path = segment?.segmentLatLngList ?? []
    } catch {
      if (!state.active || request !== state.request) return
      state.path = []
    }
    state.rerouting = state.path.length < 2
    publishRoute()
  }, [controller, publishRoute])

  useEffect(() => {
    const state = session.current
    state.alive = true
    setOnLocationChanged(location => {
      if (!Number.isFinite(location.lat) || !Number.isFinite(location.lng)) return
      state.location = location
      state.locationAtMs = Date.now()
      setLocationReady(true)
      publishRoute()
    })
    setOnRouteChanged(() => { if (state.active) void refreshRoute() })
    setOnReroutingRequestedByOffRoute(() => {
      ++state.request
      state.path = []
      state.rerouting = true
      publishRoute()
    })
    setOnTurnByTurn(events => {
      const event = events[0]
      if (!state.active || !event || event.navState === NavState.UNKNOWN) return
      if (event.navState !== NavState.ENROUTE) {
        ++state.request
        state.path = []
        state.maneuver = ''
        state.rerouting = true
      } else {
        const instruction = event.currentStep?.instruction?.trim()
        if (instruction) state.maneuver = instruction
        if (event.routeChanged || !state.path.length || state.rerouting) void refreshRoute()
      }
      publishRoute()
    })
    setOnArrival(event => {
      if (!event.isFinalDestination) return
      state.active = false
      onRoute(null)
      setGuiding(false)
      setStatus('Arrived at the destination.')
      void controller.stopGuidance().catch(() => {})
    })
    return () => {
      state.active = false
      state.alive = false
      ++state.request
      setOnLocationChanged(null)
      setOnRouteChanged(null)
      setOnReroutingRequestedByOffRoute(null)
      setOnTurnByTurn(null)
      setOnArrival(null)
      onRoute(null)
      if (state.initialized) void controller.cleanup().catch(() => {})
    }
  }, [controller, onRoute, publishRoute, refreshRoute, setOnArrival, setOnLocationChanged,
    setOnReroutingRequestedByOffRoute, setOnRouteChanged, setOnTurnByTurn])

  async function connect() {
    if (working.current) return
    const state = session.current
    working.current = true
    setBusy(true)
    try {
      if (!(await requestForegroundPermissionsAsync()).granted) throw new Error('Location permission is required.')
      if (!await controller.showTermsAndConditionsDialog()) throw new Error('Google navigation terms were declined.')
      if (!state.alive) return
      const result = await controller.init()
      if (result !== NavigationSessionStatus.OK) throw new Error(`Google Navigation initialization: ${result}`)
      if (!state.alive) { await controller.cleanup(); return }
      state.initialized = true
      // The SDK only emits turn-by-turn callbacks when this flag is enabled.
      controller.setTurnByTurnLoggingEnabled(true)
      await controller.startUpdatingLocation()
      setInitialized(true)
      setStatus('')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Google Navigation could not initialize.')
    } finally { working.current = false; setBusy(false) }
  }

  async function start(place = selected, fromSiri = selectedFromSiri) {
    if (working.current || session.current.active) return
    const state = session.current
    const title = place?.label ?? destination.trim()
    const parts = title.split(',').map(value => value.trim())
    const [lat, lng] = parts.map(Number)
    if (!manual && !place) return
    if (!title || (manual && parts.length > 1 && (parts.length !== 2 || parts.some(part => !part) ||
      !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180))) {
      setStatus('Enter valid latitude, longitude or a Google Place ID.')
      return
    }
    if (!state.location) { setStatus('Waiting for the first Google location fix. Try again shortly.'); return }
    working.current = true
    setBusy(true)
    setStatus('Finding a walking route…')
    state.destination = title
    state.path = []
    state.maneuver = ''
    state.rerouting = true
    try {
      const waypoint = place ? { title, placeId: place.placeId }
        : parts.length === 2 ? { title, position: { lat, lng } } : { title, placeId: title }
      const result = await controller.setDestinations([waypoint], { routingOptions: { travelMode: TravelMode.WALKING } })
      if (result !== RouteStatus.OK) throw new Error(`Walking route unavailable: ${result}`)
      if (!state.alive) return
      await controller.setAudioGuidanceSettings({
        guidanceMode: spokenDirections ? AudioGuidanceMode.VOICE_ALERTS_AND_GUIDANCE : AudioGuidanceMode.SILENT,
        vibrationEnabled: false,
        bluetoothAudioEnabled: false,
      })
      if (!state.alive) return
      state.active = true
      await controller.startGuidance()
      if (!state.alive || !state.active) return
      setGuiding(true)
      setStatus('')
      try {
        if (fromSiri || announceStart) nativeDepth?.announceRoute?.(place?.label ?? null)
      } catch (error) {
        console.warn('Route started, but the announcement could not play.', error)
      }
      publishRoute()
      void refreshRoute()
    } catch (error) {
      state.active = false
      setGuiding(false)
      onRoute(null)
      setStatus(error instanceof Error ? error.message : 'Could not start walking guidance.')
    } finally { working.current = false; setBusy(false) }
  }

  async function stop() {
    if (working.current) return
    working.current = true
    setBusy(true)
    session.current.active = false
    onRoute(null)
    setGuiding(false)
    try { await controller.stopGuidance(); setStatus('Walking navigation stopped.') }
    catch { setStatus('The Google navigation session could not stop cleanly.') }
    finally { working.current = false; setBusy(false) }
  }

  const endRoute = useEffectEvent(() => { void stop() })
  useEffect(() => {
    if (endRequest === handledEnd.current || busy) return
    handledEnd.current = endRequest
    if (session.current.active) endRoute()
  }, [endRequest, busy])

  if (!visible) return null

  return <View style={{ gap: 12 }}>
    {status ? <Text accessibilityLiveRegion="polite" style={styles.muted}>{status}</Text> : null}
    {!initialized ? <ActionButton primary label={busy ? 'Setting up navigation…' : 'Enable Google Navigation'}
      disabled={busy} onPress={() => void connect()} /> : <>
      {!guiding && <>
      {voiceOnly ? <Text style={styles.label}>{destination}</Text> : <>
      <Text style={styles.label}>Destination</Text>
      <TextInput accessibilityLabel="Walking destination"
        accessibilityHint={manual ? 'Enter latitude and longitude or a Google Place ID' : 'Type or dictate a place, then swipe to the search results'}
        placeholder={manual ? 'Latitude, longitude or Place ID' : 'Search a place or address'}
        placeholderTextColor="#aab9c9" value={destination} editable={!guiding && !busy}
        autoCapitalize={manual ? 'none' : 'sentences'} returnKeyType={manual ? 'done' : 'search'}
        onChangeText={editDestination} style={styles.input} />
      </>}
      {!manual && (suggestions.length > 0 || selected) && <View style={styles.suggestions}>
        {suggestions.length > 0 && <Text accessibilityRole="header" style={styles.resultsHeading}>Search results</Text>}
        {suggestions.map(place => <ActionButton key={place.placeId} label={place.label} disabled={busy}
          hint="Selects this destination and moves to Start walk" onPress={() => {
            focusStart.current = true
            selectPlace(place)
          }} />)}
        <Text style={styles.attribution}>Google Maps</Text>
      </View>}
      {searchStatus ? <Text accessibilityLiveRegion="polite" style={styles.muted}>{searchStatus}</Text> : null}
      {autoPlace && !locationReady && <Text style={styles.muted}>Waiting for your location…</Text>}
      </>}
      <ActionButton ref={startButton} primary label={guiding ? 'End walk' : 'Start walk'}
        hint={guiding ? 'Stops navigation to your destination' : selected ? `Starts walking guidance to ${selected.label}` : 'Starts walking guidance'}
        disabled={busy || (!guiding && (manual ? !destination.trim() : !selected))}
        onPress={() => void (guiding ? stop() : start())} />
    </>}
    {!guiding && !voiceOnly && <>
      <ActionButton label="Route options" expanded={showOptions} onPress={() => setShowOptions(!showOptions)} />
      {showOptions && <>
        <SettingSwitch label="Spoken walking directions" value={spokenDirections} disabled={busy} onChange={setSpokenDirections} />
        {nativeDepth?.announceRoute && <SettingSwitch label="Announce route start" value={announceStart}
          disabled={busy} onChange={setAnnounceStart} />}
        {nativeDepth?.setSiriAutoStart && <SettingSwitch label="Start spoken routes automatically" value={autoStart}
          disabled={busy} onChange={enabled => {
            nativeDepth?.setSiriAutoStart?.(enabled)
            setAutoStart(enabled)
            if (!enabled) setAutoPlace(null)
          }} />}
        {initialized && nativeDepth?.searchPlaces && <ActionButton disabled={busy}
          label={manual ? 'Search by name or address' : 'Enter coordinates or Place ID'}
          onPress={() => { editDestination(''); setManual(!manual) }} />}
      </>}
    </>}
  </View>
}

const styles = StyleSheet.create({
  muted: { color: terminal.muted, fontSize: 17 },
  input: { color: terminal.text, fontSize: 18, minHeight: 56, borderWidth: 1, borderColor: terminal.border,
    borderRadius: 12, backgroundColor: terminal.background, paddingHorizontal: 14, paddingVertical: 12 },
  suggestions: { gap: 8 },
  resultsHeading: { color: terminal.accent, fontSize: 17, fontWeight: '600' },
  label: { color: terminal.text, fontSize: 17 },
  attribution: { color: '#aab9c9', fontSize: 12, textAlign: 'right', padding: 8 },
})
