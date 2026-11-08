Pod::Spec.new do |s|
  s.name           = 'NavigationDepth'
  s.version        = '0.1.0'
  s.summary        = 'ARKit, Core Bluetooth, and Core ML for Navigation Belt'
  s.description    = s.summary
  s.author         = 'Navigation Belt team'
  s.homepage       = 'https://github.com'
  s.license        = { :type => 'UNLICENSED' }
  s.platform       = :ios, '17.0'
  s.source         = { :git => '' }
  s.static_framework = true
  s.swift_version  = '5.9'
  s.pod_target_xcconfig = { 'SWIFT_OPTIMIZATION_LEVEL' => '-O' }
  s.dependency 'ExpoModulesCore'
  spm_dependency(
    s,
    url: 'https://github.com/googlemaps/ios-places-sdk.git',
    requirement: { kind: 'exactVersion', version: '11.2.0' },
    products: ['GooglePlaces']
  )
  s.frameworks = 'ARKit', 'AVFoundation', 'CoreVideo', 'CoreBluetooth', 'CoreML', 'Vision'
  packages = 'Models/{Traversability,GlassSegmentation,StairSegmentation,PersonDetection}.{mlmodelc,mlpackage}'
  unless Dir.glob(File.join(__dir__, packages)).empty?
    s.resource_bundles = { 'NavigationModels' => [packages] }
  end
  s.source_files = '**/*.swift'
end
