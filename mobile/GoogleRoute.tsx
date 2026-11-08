import { Text } from 'react-native'
import type { Route } from '../shared/contracts'

export interface GoogleRouteProps {
  onRoute: (route: Route | null) => void
  siriDestination?: { query: string }
  visible: boolean
  endRequest: number
}

export default function GoogleRoute({ visible }: GoogleRouteProps) {
  if (!visible) return null
  return <Text style={{ color: '#aab9c9' }}>Google walking routes are available in the iPhone development build.</Text>
}
