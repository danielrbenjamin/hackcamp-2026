import { StyleSheet, Text, View } from 'react-native'
import type { Route } from '../shared/contracts'
import { mono, terminal } from './terminal'

export function RouteCard({ route }: { route: Route | undefined }) {
  if (!route || route.status === 'idle') return null
  const bearing = route.desiredHeading
  const rerouting = route.status === 'rerouting'
  const direction = bearing === null || !Number.isFinite(bearing) ? null
    : Math.abs(bearing) >= 135 ? 'behind' : Math.abs(bearing) < 10 ? 'ahead' : bearing < 0 ? 'left' : 'right'
  return <View style={[styles.card, rerouting && styles.rerouting]}>
    <View style={styles.details}>
      <Text style={[styles.state, rerouting && styles.warning]}>
        {rerouting ? 'Finding a new route' : route.source === 'simulated' ? 'Simulated guidance' : 'Navigating to'}
      </Text>
      <Text accessibilityRole="header" style={styles.destination}>{route.destination}</Text>
      {route.maneuver ? <Text style={styles.instruction}>{route.maneuver}</Text> : null}
    </View>
    {direction && <View style={styles.compass} accessible accessibilityLabel={`Route direction: ${direction}`}>
      <View style={styles.dial}>
        <Text accessible={false} style={[styles.arrow, { transform: [{ rotate: `${bearing}deg` }] }]}>↑</Text>
      </View>
      <Text aria-hidden style={styles.direction}>{direction}</Text>
    </View>}
  </View>
}

const styles = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderLeftWidth: 3,
    borderColor: '#456776', borderRadius: 12, backgroundColor: terminal.background, padding: 12 },
  rerouting: { borderColor: '#e5b57e' },
  details: { flex: 1, gap: 4 },
  state: { color: '#a7edff', fontFamily: mono, fontWeight: '700', fontSize: 17 },
  warning: { color: '#e5b57e' },
  destination: { color: terminal.text, fontSize: 24, fontWeight: '700' },
  instruction: { color: terminal.muted, fontSize: 19 },
  compass: { alignItems: 'center', gap: 4 },
  dial: { alignItems: 'center', justifyContent: 'center', width: 42, height: 42,
    borderWidth: 1, borderColor: '#456776', borderRadius: 21 },
  arrow: { color: '#9dd9e8', fontSize: 25, lineHeight: 31, textAlign: 'center' },
  direction: { color: terminal.muted, fontSize: 15 },
})
