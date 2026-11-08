import { Platform } from 'react-native'

export const mono = Platform.select({ ios: 'Menlo', default: 'monospace' })

export const terminal = {
  background: '#0c1015',
  surface: '#171e26',
  control: '#273643',
  border: '#718799',
  text: '#f6f9fc',
  muted: '#c3d0dc',
  accent: '#a7edff',
  accentText: '#091921',
}
