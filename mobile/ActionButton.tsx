import { Pressable, StyleSheet, Text } from 'react-native'
import { mono } from './terminal'

export function ActionButton({ label, onPress, selected, disabled, primary, hint }: {
  label: string
  onPress: () => void
  selected?: boolean
  disabled?: boolean
  primary?: boolean
  hint?: string
}) {
  return <Pressable accessibilityRole="button" accessibilityHint={hint}
    accessibilityState={{ selected, disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.button, selected && styles.selected, primary && styles.primary,
      disabled && styles.disabled, pressed && styles.pressed]}>
    <Text style={[styles.label, primary && !disabled && styles.primaryLabel]}>{label}</Text>
  </Pressable>
}

const styles = StyleSheet.create({
  button: { minHeight: 52, paddingHorizontal: 16, paddingVertical: 12, justifyContent: 'center',
    borderWidth: 1, borderColor: '#728795', backgroundColor: '#101820' },
  selected: { borderColor: '#a7edff', backgroundColor: '#243e4d' },
  primary: { borderColor: '#a7edff', backgroundColor: '#a7edff' },
  disabled: { borderColor: '#728795', backgroundColor: '#26323b' },
  pressed: { opacity: 0.8 },
  label: { color: '#f5fafc', fontFamily: mono, fontSize: 17, fontWeight: '600', textAlign: 'center' },
  primaryLabel: { color: '#0a202a' },
})
