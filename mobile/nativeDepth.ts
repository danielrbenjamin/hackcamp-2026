import { requireOptionalNativeModule } from 'expo'
import type { BeltStatus, Cue, Five, ModelPreview, Observation, Prediction } from '../shared/contracts'

export type DepthStatus = 'idle' | 'starting' | 'running' | 'unsupported' | 'denied' | 'interrupted' | 'failed'
export interface PlaceSuggestion {
  placeId: string
  label: string
  name?: string
}
interface Events {
  onObservation: Observation
  onStatus: { status: DepthStatus }
  onBeltStatus: BeltStatus & { state: string }
  onSiriDestination: Record<string, never>
  onHazardPreview: ModelPreview
}

interface DepthModule {
  start(): void
  stop(): void
  hasGoogleNavigation(): boolean
  announceRoute?(destination: string | null): void
  searchPlaces?(query: string): Promise<PlaceSuggestion[]>
  searchPlacesNear?(query: string, latitude: number, longitude: number): Promise<PlaceSuggestion[]>
  takeSiriDestination?(): Promise<string | null>
  getSiriAutoStart?(): boolean
  setSiriAutoStart?(enabled: boolean): void
  recordDepth(enabled: boolean): void
  previewDepth?(enabled: boolean): void
  previewHazards?(enabled: boolean): void
  connectBelt(): void
  disconnectBelt(): void
  sendBelt(cue: Cue, strengths: Five<number>): void
  predict(cells: readonly number[]): Promise<Prediction | null>
  addListener<K extends keyof Events>(name: K, handler: (event: Events[K]) => void): { remove(): void }
}

export const nativeDepth = requireOptionalNativeModule<DepthModule>('NavigationDepth')
