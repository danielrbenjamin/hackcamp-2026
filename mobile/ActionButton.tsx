import type { ComponentRef, Ref } from 'react'
import { Pressable, StyleSheet, Text } from 'react-native'
import { terminal } from './terminal'

export function ActionButton({ label, onPress, selected, disabled, primary, hint, expanded, tile, ref }: {
  label: string
  onPress: () => void
  selected?: boolean
  disabled?: boolean
  primary?: boolean
  hint?: string
  expanded?: boolean
  tile?: boolean
  ref?: Ref<ComponentRef<typeof Pressable>>
}) {
  return <Pressable ref={ref} accessibilityRole="button" accessibilityLabel={label} accessibilityHint={hint}
    accessibilityState={{ selected, disabled, expanded }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.button, tile && styles.tile, selected && styles.selected, primary && styles.primary,
      disabled && styles.disabled, pressed && styles.pressed]}>
    <Text style={[styles.label, primary && styles.centered, primary && !disabled && styles.primaryLabel]}>{label}</Text>
    {expanded !== undefined && <Text aria-hidden style={[styles.marker, expanded && styles.expanded]}>›</Text>}
  </Pressable>
}

const styles = StyleSheet.create({
  button: { minHeight: 56, paddingHorizontal: 18, paddingVertical: 13, flexDirection: 'row',
    alignItems: 'center', gap: 12, borderWidth: 1, borderRadius: 14, borderColor: 'transparent',
    backgroundColor: terminal.control },
  selected: { borderColor: terminal.accent, backgroundColor: '#244353' },
  tile: { flex: 1, minHeight: 76, paddingHorizontal: 12, paddingVertical: 10 },
  primary: { borderColor: terminal.accent, backgroundColor: terminal.accent },
  disabled: { borderColor: '#526475', backgroundColor: '#24303a' },
  pressed: { opacity: 0.82 },
  label: { flexShrink: 1, flexGrow: 1, color: terminal.text, fontSize: 18, fontWeight: '600' },
  centered: { textAlign: 'center' },
  primaryLabel: { color: terminal.accentText, fontWeight: '700' },
  marker: { color: terminal.accent, fontSize: 22 },
  expanded: { transform: [{ rotate: '90deg' }] },
})
