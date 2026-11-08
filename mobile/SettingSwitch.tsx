import { Pressable, StyleSheet, Switch, Text, View } from 'react-native'
import { terminal } from './terminal'

export function SettingSwitch({ label, value, onChange, hint, disabled }: {
  label: string
  value: boolean
  onChange: (value: boolean) => void
  hint?: string
  disabled?: boolean
}) {
  return <Pressable accessibilityRole="switch" accessibilityLabel={label} accessibilityHint={hint}
    accessibilityState={{ checked: value, disabled }} disabled={disabled}
    onPress={() => onChange(!value)} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
    <Text aria-hidden style={styles.label}>{label}</Text>
    <View aria-hidden pointerEvents="none">
      <Switch value={value} disabled={disabled} trackColor={{ true: '#26829a' }} />
    </View>
  </Pressable>
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingVertical: 5 },
  label: { flex: 1, color: terminal.text, fontSize: 17, fontWeight: '500' },
  pressed: { opacity: 0.75 },
})
