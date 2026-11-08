import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { Keyboard, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native'
import { requestForegroundPermissionsAsync } from 'expo-location'
import { NavigationProvider, NavigationSessionStatus, NavState, RouteStatus, TravelMode, useNavigation } from '@googlemaps/react-native-navigation-sdk'
import { routeBearing, type Coordinate } from '../shared/geo'
import type { Route } from '../shared/contracts'
import type { GoogleRouteProps } from './GoogleRoute'
import { nativeDepth, type PlaceSuggestion } from './nativeDepth'
import { ActionButton } from './ActionButton'
import { mono } from './terminal'

const termsOptions = { title: 'Lantern', companyName: 'Lantern' }

export default function GoogleRoute(props: GoogleRouteProps) {
  if (!nativeDepth?.hasGoogleNavigation()) {
    return <Text style={{ color: '#aab9c9' }}>Build with GOOGLE_MAPS_IOS_API_KEY to enable Google walking routes.</Text>
  }
  return <NavigationProvider termsAndConditionsDialogOptions={termsOptions}>
    <WalkingRoute {...props} />
  </NavigationProvider>
}

function WalkingRoute({ onRoute, siriDestination }: GoogleRouteProps) {
  const {
    navigationController: controller, setOnLocationChanged, setOnRouteChanged,
    setOnReroutingRequestedByOffRoute, setOnTurnByTurn, setOnArrival,
  } = useNavigation()
  const [destination, setDestination] = useState('')
  const [status, setStatus] = useState('')
  const [manual, setManual] = useState(!nativeDepth?.searchPlaces)
  const [selected, setSelected] = useState<PlaceSuggestion | null>(null)
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([])
  const [searchStatus, setSearchStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [showOptions, setShowOptions] = useState(false)
  const working = useRef(false)
  const [guiding, setGuiding] = useState(false)
  const [initialized, setInitialized] = useState(false)
  const [locationReady, setLocationReady] = useState(false)
  const [autoStart, setAutoStart] = useState(() => nativeDepth?.getSiriAutoStart?.() ?? false)
  const [spokenSearch, setSpokenSearch] = useState<GoogleRouteProps['siriDestination']>()
  const [autoPlace, setAutoPlace] = useState<PlaceSuggestion | null>(null)
  const handledSiri = useRef<GoogleRouteProps['siriDestination']>(undefined)
  const session = useRef({ initialized: false, active: false, alive: true, request: 0, location: null as Coordinate | null,
    locationAtMs: 0, path: [] as Coordinate[], destination: '', maneuver: '', rerouting: false })

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
    selectPlace(place)
    void start(place)
  })

  useEffect(() => {
    if (autoStart && autoPlace && locationReady && !busy && !guiding) startSiriRoute(autoPlace)
  }, [autoStart, autoPlace, locationReady, busy, guiding])

  function editDestination(value: string) {
    setDestination(value)
    setSelected(null)
    setSuggestions([])
    setSpokenSearch(undefined)
    setAutoPlace(null)
    setSearchStatus(!manual && value.trim().length >= 3 ? 'Searching…' : '')
  }

  function selectPlace(place: PlaceSuggestion) {
    setSelected(place)
    setDestination(place.label)
    setSuggestions([])
    setSearchStatus('')
    setSpokenSearch(undefined)
    setAutoPlace(null)
    Keyboard.dismiss()
  }

  useEffect(() => {
    const state = session.current
    state.alive = true
    function publish() {
      if (!state.active) return
      const bearing = state.location && !state.rerouting ? routeBearing(state.location, state.path) : null
      onRoute({ source: 'google', status: state.rerouting ? 'rerouting' : 'guiding',
        destination: state.destination, maneuver: state.maneuver, desiredHeading: null,
        trueBearing: bearing ?? undefined, updatedAtMs: state.locationAtMs })
    }
    async function refresh() {
      const request = ++state.request
      try {
        const segment = await controller.getCurrentRouteSegment()
        if (!state.active || request !== state.request) return
        state.path = segment?.segmentLatLngList ?? []
        state.rerouting = state.path.length < 2
        publish()
      } catch {
        if (request === state.request) { state.path = []; state.rerouting = true; publish() }
      }
    }
    setOnLocationChanged(location => {
      state.location = location
      state.locationAtMs = Date.now()
      setLocationReady(true)
      publish()
    })
    setOnRouteChanged(() => { if (state.active) void refresh() })
    setOnReroutingRequestedByOffRoute(() => {
      ++state.request
      state.path = []
      state.rerouting = true
      publish()
    })
    setOnTurnByTurn(events => {
      const event = events[0]
      if (!state.active || !event) return
      state.maneuver = event.currentStep?.instruction ?? 'Waiting for maneuver'
      if (event.navState !== NavState.ENROUTE) {
        state.rerouting = true
      } else if (event.routeChanged || !state.path.length || state.rerouting) {
        void refresh()
      }
      publish()
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
  }, [controller, onRoute, setOnArrival, setOnLocationChanged, setOnReroutingRequestedByOffRoute, setOnRouteChanged, setOnTurnByTurn])

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
      await controller.startUpdatingLocation()
      setInitialized(true)
      setStatus('')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Google Navigation could not initialize.')
    } finally { working.current = false; setBusy(false) }
  }

  async function start(place = selected) {
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
    state.maneuver = 'Calculating walking route'
    state.rerouting = true
    try {
      const waypoint = place ? { title, placeId: place.placeId }
        : parts.length === 2 ? { title, position: { lat, lng } } : { title, placeId: title }
      const result = await controller.setDestinations([waypoint], { routingOptions: { travelMode: TravelMode.WALKING } })
      if (result !== RouteStatus.OK) throw new Error(`Walking route unavailable: ${result}`)
      if (!state.alive) return
      state.active = true
      await controller.startGuidance()
      if (!state.alive || !state.active) return
      setGuiding(true)
      setStatus('')
      try {
        nativeDepth?.announceRoute?.(place?.label ?? null)
      } catch (error) {
        console.warn('Route started, but the announcement could not play.', error)
      }
      if (state.maneuver === 'Calculating walking route') state.maneuver = 'Waiting for the next maneuver'
      onRoute({ source: 'google', status: 'guiding', destination: title,
        maneuver: state.maneuver, desiredHeading: null, updatedAtMs: state.locationAtMs })
      const request = ++state.request
      void controller.getCurrentRouteSegment().then(segment => {
        if (!state.active || request !== state.request) return
        state.path = segment?.segmentLatLngList ?? []
        state.rerouting = state.path.length < 2
        const bearing = state.location ? routeBearing(state.location, state.path) : null
        onRoute({ source: 'google', status: state.rerouting ? 'rerouting' : 'guiding',
          destination: title, maneuver: state.maneuver, desiredHeading: null, trueBearing: bearing ?? undefined,
          updatedAtMs: state.locationAtMs })
      }).catch(() => {})
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

  return <View style={{ gap: 12 }}>
    {status ? <Text accessibilityLiveRegion="polite" style={styles.muted}>{status}</Text> : null}
    {!initialized ? <ActionButton primary label={busy ? 'Setting up navigation…' : 'Enable Google Navigation'}
      disabled={busy} onPress={() => void connect()} /> : <>
      {!guiding && <>
      <Text style={styles.label}>Destination</Text>
      <TextInput accessibilityLabel="Walking destination" placeholder={manual ? 'Latitude, longitude or Place ID' : 'Search a place or address'}
        placeholderTextColor="#aab9c9" value={destination} editable={!guiding && !busy}
        autoCapitalize={manual ? 'none' : 'sentences'} returnKeyType={manual ? 'done' : 'search'}
        onChangeText={editDestination} style={styles.input} />
      {!manual && (suggestions.length > 0 || selected) && <View style={styles.suggestions}>
        {suggestions.map(place => <Pressable key={place.placeId} accessibilityRole="button" style={styles.suggestion}
          onPress={() => selectPlace(place)}><Text style={styles.label}>{place.label}</Text></Pressable>)}
        <Text style={styles.attribution}>Google Maps</Text>
      </View>}
      {searchStatus ? <Text accessibilityLiveRegion="polite" style={styles.muted}>{searchStatus}</Text> : null}
      {autoPlace && !locationReady && <Text style={styles.muted}>Waiting for your location…</Text>}
      </>}
      <ActionButton primary label={guiding ? 'End walk' : 'Start walk'}
        hint={guiding ? 'Stops navigation to your destination' : 'Starts Google turn-by-turn walking directions to the selected destination'}
        disabled={busy || (!guiding && (manual ? !destination.trim() : !selected))}
        onPress={() => void (guiding ? stop() : start())} />
    </>}
    {!guiding && (nativeDepth?.setSiriAutoStart || nativeDepth?.searchPlaces) && <>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: showOptions }}
        style={styles.optionButton} onPress={() => setShowOptions(!showOptions)}>
        <Text style={styles.optionText}>{showOptions ? 'Hide route options' : 'Route options'}</Text>
      </Pressable>
      {showOptions && <>
        {nativeDepth?.setSiriAutoStart && <View style={styles.siriSetting}>
          <Text style={[styles.label, styles.settingLabel]}>Start Siri routes automatically</Text>
          <Switch accessibilityLabel="Start Siri routes automatically" value={autoStart} onValueChange={enabled => {
            nativeDepth?.setSiriAutoStart?.(enabled)
            setAutoStart(enabled)
            if (!enabled) setAutoPlace(null)
          }} />
        </View>}
        {initialized && nativeDepth?.searchPlaces && <ActionButton disabled={busy}
          label={manual ? 'Search by name or address' : 'Enter coordinates or Place ID'}
          onPress={() => { editDestination(''); setManual(!manual) }} />}
      </>}
    </>}
  </View>
}

const styles = StyleSheet.create({
  muted: { color: '#c8d8e2', fontFamily: mono, fontSize: 17 },
  input: { color: '#f5fafc', fontFamily: mono, fontSize: 18, minHeight: 54, borderWidth: 1, borderColor: '#728795',
    backgroundColor: '#090b0e', paddingHorizontal: 14, paddingVertical: 12 },
  suggestions: { borderWidth: 1, borderColor: '#32404c', backgroundColor: '#121a21' },
  suggestion: { minHeight: 52, justifyContent: 'center', padding: 12, borderBottomWidth: 1, borderColor: '#728795' },
  label: { color: '#f5fafc', fontFamily: mono, fontSize: 17 },
  attribution: { color: '#aab9c9', fontSize: 12, textAlign: 'right', padding: 8 },
  optionButton: { minHeight: 48, justifyContent: 'center' },
  optionText: { color: '#a7edff', fontFamily: mono, fontSize: 17, fontWeight: '600' },
  siriSetting: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8, minHeight: 48 },
  settingLabel: { flex: 1 },
})
