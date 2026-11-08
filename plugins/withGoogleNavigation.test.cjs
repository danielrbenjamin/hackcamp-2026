const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { test } = require('node:test')
const withGoogleNavigation = require('./withGoogleNavigation')

test('Google navigation adds required iOS background modes without duplicating existing modes', async t => {
  const key = process.env.GOOGLE_MAPS_IOS_API_KEY
  t.after(() => {
    if (key === undefined) delete process.env.GOOGLE_MAPS_IOS_API_KEY
    else process.env.GOOGLE_MAPS_IOS_API_KEY = key
  })
  process.env.GOOGLE_MAPS_IOS_API_KEY = 'test-key'
  const config = withGoogleNavigation({ name: 'Test', slug: 'test' })
  const mod = config.mods.ios.infoPlist
  const result = await mod({ modRequest: {}, modResults: { UIBackgroundModes: ['bluetooth-central', 'location'] } })
  assert.deepEqual(result.modResults.UIBackgroundModes, ['bluetooth-central', 'location', 'audio'])
})

test('Google key setup applies once to the installed Expo AppDelegate template', async () => {
  const config = withGoogleNavigation({ name: 'Test', slug: 'test' })
  const mod = config.mods.ios.appDelegate
  const template = execFileSync('tar', ['-xOf', 'node_modules/expo/template.tgz',
    'package/ios/HelloWorld/AppDelegate.swift'], { encoding: 'utf8' })
  const result = await mod({ modRequest: {}, modResults: { contents: template } })
  assert.match(result.modResults.contents, /import GoogleMaps/)
  assert.match(result.modResults.contents, /Bundle.main.object\(forInfoDictionaryKey: "GMSApiKey"\)/)
  const second = await mod({ modRequest: {}, modResults: result.modResults })
  assert.equal(second.modResults.contents, result.modResults.contents)
})
