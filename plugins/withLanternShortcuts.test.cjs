const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { IOSConfig } = require('expo/config-plugins')
const withLanternShortcuts = require('./withLanternShortcuts')

test('adds the Siri shortcut to the Expo iOS app target once', async t => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-xcode-'))
  const ios = path.join(projectRoot, 'ios')
  const app = path.join(ios, 'HelloWorld')
  const project = path.join(ios, 'HelloWorld.xcodeproj')
  const shortcut = path.join(app, 'LanternShortcuts.swift')
  const files = [shortcut, path.join(app, 'AppDelegate.swift'), path.join(project, 'project.pbxproj')]
  t.after(() => {
    for (const file of files) fs.rmSync(file, { force: true })
    for (const directory of [app, project, ios, projectRoot]) fs.rmdirSync(directory)
  })
  for (const directory of [ios, app, project]) fs.mkdirSync(directory)
  for (const entry of ['HelloWorld/AppDelegate.swift', 'HelloWorld.xcodeproj/project.pbxproj']) {
    fs.writeFileSync(path.join(ios, entry), execFileSync('tar', ['-xOf', 'node_modules/expo/template.tgz', 'package/ios/' + entry]))
  }
  const mod = withLanternShortcuts({ name: 'Lantern', slug: 'lantern' }).mods.ios.xcodeproj
  const request = { modRequest: { projectRoot }, modResults: IOSConfig.XcodeUtils.getPbxproj(projectRoot) }
  const result = await mod(request)
  assert.match(fs.readFileSync(shortcut, 'utf8'), /struct NavigateWithLantern: AppIntent/)
  const output = result.modResults.writeSync()
  assert.match(output, /path = "?HelloWorld\/LanternShortcuts\.swift"?;/)
  const sourcePhase = output.match(/Begin PBXSourcesBuildPhase section[\s\S]*?End PBXSourcesBuildPhase section/)[0]
  assert.equal((sourcePhase.match(/LanternShortcuts.swift in Sources/g) ?? []).length, 1)
  assert.equal((await mod({ ...request, modResults: result.modResults })).modResults.writeSync(), output)
})
