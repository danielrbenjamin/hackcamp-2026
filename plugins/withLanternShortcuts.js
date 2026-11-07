const fs = require('node:fs')
const path = require('node:path')
const { IOSConfig, withXcodeProject } = require('expo/config-plugins')

module.exports = function withLanternShortcuts(config) {
  return withXcodeProject(config, mod => {
    const sourceRoot = IOSConfig.Paths.getSourceRoot(mod.modRequest.projectRoot)
    const filename = 'LanternShortcuts.swift'
    fs.copyFileSync(path.join(__dirname, filename), path.join(sourceRoot, filename))
    mod.modResults = IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
      filepath: path.posix.join(path.basename(sourceRoot), filename),
      groupName: path.basename(sourceRoot),
      project: mod.modResults,
    })
    return mod
  })
}
