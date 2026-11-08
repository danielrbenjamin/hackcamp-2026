import type { ComponentRef, Ref } from 'react'
import { Pressable, StyleSheet, Text } from 'react-native'
import { terminal } from './terminal'

export function ActionButton({ label, onPress, selected, disabled, primary, hint, expanded, ref }: {
  label: string
  onPress: () => void
  selected?: boolean
  disabled?: boolean
  primary?: boolean
  hint?: string
  expanded?: boolean
  ref?: Ref<ComponentRef<typeof Pressable>>
}) {
  return <Pressable ref={ref} accessibilityRole="button" accessibilityLabel={label} accessibilityHint={hint}
    accessibilityState={{ selected, disabled, expanded }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.button, selected && styles.selected, primary && styles.primary,
      disabled && styles.disabled, pressed && styles.pressed]}>
    <Text style={[styles.label, primary && !disabled && styles.primaryLabel]}>{label}</Text>
    {expanded !== undefined && <Text aria-hidden style={styles.marker}>{expanded ? '−' : '+'}</Text>}
  </Pressable>
}

const styles = StyleSheet.create({
  button: { minHeight: 56, paddingHorizontal: 16, paddingVertical: 12, flexDirection: 'row',
    alignItems: 'center', gap: 12, borderWidth: 1, borderRadius: 12, borderColor: terminal.border,
    backgroundColor: terminal.control },
  selected: { borderColor: terminal.accent, backgroundColor: '#244353' },
  primary: { borderColor: terminal.accent, backgroundColor: terminal.accent },
  disabled: { borderColor: '#526475', backgroundColor: '#24303a' },
  pressed: { opacity: 0.82 },
  label: { flexShrink: 1, flexGrow: 1, color: terminal.text, fontSize: 18, fontWeight: '600' },
  primaryLabel: { color: terminal.accentText, fontWeight: '700' },
  marker: { color: terminal.accent, fontSize: 22 },
})
