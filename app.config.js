module.exports = ({ config }) => {
  const key = process.env.GOOGLE_MAPS_IOS_API_KEY?.trim()
  return {
    ...config,
    ios: {
      ...config.ios,
      deploymentTarget: '17.0',
      infoPlist: {
        ...config.ios?.infoPlist,
        NSLocationWhenInUseUsageDescription: 'Your location and heading are used for walking routes.',
        NSMotionUsageDescription: 'Motion data improves route guidance.',
        NSBluetoothAlwaysUsageDescription: 'Bluetooth connects to the five-motor navigation belt.',
        NSLocalNetworkUsageDescription: 'Connect to your local telemetry dashboard when streaming is enabled.',
        NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
      },
    },
    plugins: [
      ...(config.plugins ?? []),
      'expo-sharing',
      './plugins/withLanternShortcuts',
      ['expo-build-properties', { ios: { deploymentTarget: '17.0' } }],
      ...(key ? ['./plugins/withGoogleNavigation'] : []),
    ],
  }
}
