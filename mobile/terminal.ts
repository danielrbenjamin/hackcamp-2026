import { Platform } from 'react-native'

export const mono = Platform.select({ ios: 'Menlo', default: 'monospace' })

export const terminal = {
  background: '#090e14',
  surface: '#111b25',
  control: '#1b2b39',
  border: '#647e91',
  text: '#f2f8fc',
  muted: '#c2d4e0',
  accent: '#a7edff',
  accentText: '#071b25',
}
