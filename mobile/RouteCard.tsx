import { Platform, StyleSheet, Text, View } from 'react-native'
import type { Route } from '../shared/contracts'

export function RouteCard({ route }: { route: Route | undefined }) {
  if (!route || route.status === 'idle') return null
  const bearing = route.desiredHeading
  const rerouting = route.status === 'rerouting'
  return <View style={[styles.card, rerouting && styles.rerouting]}>
    <View style={styles.details}>
      <Text style={[styles.state, rerouting && styles.warning]}>
        {rerouting ? 'REROUTING' : route.source === 'simulated' ? 'SIMULATED GUIDANCE' : 'NAVIGATING TO'}
      </Text>
      <Text accessibilityRole="header" style={styles.destination}>{route.destination}</Text>
      {route.maneuver ? <Text style={styles.instruction}>{route.maneuver}</Text> : null}
    </View>
    <View style={styles.compass} accessibilityLabel={bearing === null ? 'Route bearing unavailable' : `Route bearing ${Math.round(bearing)} degrees relative to the phone`}>
      <View style={styles.dial}>
        <Text accessible={false} style={[styles.arrow, bearing !== null && { transform: [{ rotate: `${bearing}deg` }] }]}>
          {bearing === null ? '—' : '↑'}
        </Text>
      </View>
      <Text style={styles.instruction}>{bearing === null ? 'Bearing' : `${Math.round(bearing)}°`}</Text>
    </View>
  </View>
}

const mono = Platform.OS === 'ios' ? 'Menlo' : 'monospace'
const styles = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderLeftWidth: 3,
    borderColor: '#456776', backgroundColor: '#101c25', padding: 12 },
  rerouting: { borderColor: '#e5b57e' },
  details: { flex: 1, gap: 4 },
  state: { color: '#9dd9e8', fontFamily: mono, fontWeight: '700', fontSize: 11 },
  warning: { color: '#e5b57e' },
  destination: { color: '#edf5fa', fontSize: 18, fontWeight: '700' },
  instruction: { color: '#aab9c9', fontSize: 12 },
  compass: { alignItems: 'center', gap: 4 },
  dial: { alignItems: 'center', justifyContent: 'center', width: 42, height: 42,
    borderWidth: 1, borderColor: '#456776', borderRadius: 21 },
  arrow: { color: '#9dd9e8', fontSize: 25, lineHeight: 31, textAlign: 'center' },
})
