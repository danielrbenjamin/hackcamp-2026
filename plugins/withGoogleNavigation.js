const { withAppDelegate, withInfoPlist } = require('expo/config-plugins')

module.exports = function withGoogleNavigation(config) {
  config = withInfoPlist(config, mod => {
    mod.modResults.GMSApiKey = process.env.GOOGLE_MAPS_IOS_API_KEY.trim()
    return mod
  })
  return withAppDelegate(config, mod => {
    const source = mod.modResults.contents
    const launch = /(override\s+func\s+application\s*\([^)]*didFinishLaunchingWithOptions[^)]*\)\s*->\s*Bool\s*\{)/
    if (!launch.test(source)) throw new Error('Google Navigation requires the Expo Swift AppDelegate launch method.')
    let result = source
    if (!/^import GoogleMaps$/m.test(result)) result = `import GoogleMaps\n${result}`
    if (!result.includes('GMSServices.provideAPIKey(')) {
      result = result.replace(launch, `$1
    if let key = Bundle.main.object(forInfoDictionaryKey: "GMSApiKey") as? String {
      GMSServices.provideAPIKey(key)
    }`)
    }
    mod.modResults.contents = result
    return mod
  })
}
