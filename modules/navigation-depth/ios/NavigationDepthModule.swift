import ARKit
import AVFoundation
import CoreLocation
import ExpoModulesCore
import Foundation
import simd

public final class NavigationDepthModule: Module {
  private let sensor = DepthSensor()
  private let belt = BeltLink()
  private let model = TraversabilityModel()
  private let places = PlacesSearch()
  private let routeSpeech = AVSpeechSynthesizer()
  private var siriObserver: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("NavigationDepth")
    Events("onObservation", "onStatus", "onBeltStatus", "onSiriDestination", "onHazardPreview", "onHazardPreviewStatus")
    AsyncFunction("takeSiriDestination") { () -> String? in
      let defaults = UserDefaults.standard
      let key = "lantern.siri.destination"
      let destination = defaults.dictionary(forKey: key)
      defaults.removeObject(forKey: key)
      guard let time = destination?["time"] as? Double,
            (0..<120).contains(Date().timeIntervalSince1970 - time) else { return nil }
      return destination?["query"] as? String
    }.runOnQueue(.main)
    Function("getSiriAutoStart") { UserDefaults.standard.bool(forKey: "lantern.siri.autoStart") }
    Function("setSiriAutoStart") { (enabled: Bool) in
      UserDefaults.standard.set(enabled, forKey: "lantern.siri.autoStart")
    }
    OnStartObserving("onSiriDestination") { [weak self] in
      self?.siriObserver = NotificationCenter.default.addObserver(
        forName: Notification.Name("lantern.siri.destination"), object: nil, queue: .main
      ) { [weak self] _ in self?.sendEvent("onSiriDestination", [:]) }
    }
    OnStopObserving("onSiriDestination") { [weak self] in self?.removeSiriObserver() }
    Function("hasGoogleNavigation") {
      Bundle.main.object(forInfoDictionaryKey: "GMSApiKey") is String
    }
    Function("announceRoute") { [routeSpeech = self.routeSpeech] (destination: String?) in
      DispatchQueue.main.async {
        let message = destination.map { "Navigating to \($0)." } ?? "Navigating to your destination."
        routeSpeech.usesApplicationAudioSession = false
        routeSpeech.stopSpeaking(at: .immediate)
        routeSpeech.speak(AVSpeechUtterance(string: message))
      }
    }
    AsyncFunction("searchPlaces") { [places = self.places] (query: String, promise: Promise) in
      places.search(query, promise: promise)
    }.runOnQueue(.main)
    AsyncFunction("searchPlacesNear") { [places = self.places] (query: String, latitude: Double, longitude: Double, promise: Promise) in
      places.search(query, near: CLLocationCoordinate2D(latitude: latitude, longitude: longitude), promise: promise)
    }.runOnQueue(.main)

    Function("connectBelt") { [weak self] in
      DispatchQueue.main.async {
        guard let self else { return }
        self.belt.start { [weak self] status in self?.sendEvent("onBeltStatus", status) }
      }
    }
    Function("disconnectBelt") { [weak self] in
      DispatchQueue.main.async { self?.belt.stop() }
    }
    Function("sendBelt") { [weak self] (cue: String, strengths: [Double]) in
      DispatchQueue.main.async { self?.belt.send(cue: cue, strengths: strengths) }
    }
    AsyncFunction("predict") { [model = self.model] (cells: [Int]) in
      try model.predict(cells)
    }.runOnQueue(DispatchQueue(label: "navigation.coreml"))

    Function("start") { [weak self] in
      DispatchQueue.main.async {
        guard let self else { return }
        self.sensor.start { [weak self] name, payload in
          self?.sendEvent(name, payload)
        }
      }
    }
    Function("stop") { [weak self] in
      DispatchQueue.main.async { self?.sensor.stop() }
    }
    Function("recordDepth") { [weak self] (enabled: Bool) in
      DispatchQueue.main.async { self?.sensor.recording = enabled }
    }
    Function("previewDepth") { [weak self] (enabled: Bool) in
      DispatchQueue.main.async { self?.sensor.previewing = enabled }
    }
    Function("previewHazards") { [weak self] (enabled: Bool) in
      DispatchQueue.main.async { self?.sensor.setHazardPreview(enabled) }
    }
    OnDestroy { [weak self, sensor = self.sensor, belt = self.belt] in
      self?.removeSiriObserver()
      DispatchQueue.main.async { sensor.stop(); belt.stop() }
    }
  }

  private func removeSiriObserver() {
    if let siriObserver { NotificationCenter.default.removeObserver(siriObserver) }
    siriObserver = nil
  }
}

private final class DepthSensor: NSObject, ARSessionDelegate {
  private let session = ARSession()
  private var emit: ((String, [String: Any]) -> Void)?
  private var runID = 0
  private var lastFrameTime = -Double.infinity
  private var lastDepthTime = -Double.infinity
  private let hazardModels = HazardModels()
  private let hazardQueue = DispatchQueue(label: "navigation.hazard-preview", qos: .utility)
  private var hazardEnabled = false
  private var hazardGeneration = 0
  private var hazardPending = false
  private var firstHazardPreview = true
  private var lastHazardTime = -Double.infinity
  private var recentHits: [(time: TimeInterval, points: [SIMD2<Float>])] = []
  var recording = false
  var previewing = false

  func setHazardPreview(_ enabled: Bool) {
    hazardEnabled = enabled
    hazardGeneration += 1
    lastHazardTime = -Double.infinity
    firstHazardPreview = true
    if enabled { emit?("onHazardPreviewStatus", ["message": "Waiting for ARKit tracking"]) }
  }

  func start(emit: @escaping (String, [String: Any]) -> Void) {
    stop()
    self.emit = emit
    let id = runID
    guard ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) else {
      status("unsupported")
      return
    }
    status("starting")
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized:
      run()
    case .notDetermined:
      AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
        DispatchQueue.main.async {
          guard let self, self.runID == id else { return }
          if granted { self.run() } else { self.status("denied") }
        }
      }
    default:
      status("denied")
    }
  }

  func stop() {
    runID += 1
    session.pause()
    session.delegate = nil
    emit = nil
  }

  private func run() {
    let config = ARWorldTrackingConfiguration()
    config.worldAlignment = .gravityAndHeading
    config.frameSemantics.insert(.sceneDepth)
    if ARWorldTrackingConfiguration.supportsFrameSemantics(.smoothedSceneDepth) {
      config.frameSemantics.insert(.smoothedSceneDepth)
    }
    session.delegateQueue = .main
    session.delegate = self
    lastFrameTime = -Double.infinity
    lastDepthTime = -Double.infinity
    hazardGeneration += 1
    lastHazardTime = -Double.infinity
    firstHazardPreview = true
    recentHits.removeAll()
    session.run(config, options: [.resetTracking, .removeExistingAnchors])
    status("running")
  }

  private func status(_ value: String) {
    emit?("onStatus", ["status": value])
  }

  func session(_ session: ARSession, didFailWithError error: Error) {
    status("failed")
  }

  func sessionWasInterrupted(_ session: ARSession) {
    status("interrupted")
  }

  func sessionInterruptionEnded(_ session: ARSession) {
    if emit != nil { run() }
  }

  func session(_ session: ARSession, didUpdate frame: ARFrame) {
    guard let emit, frame.timestamp - lastFrameTime >= 0.08 else { return }
    lastFrameTime = frame.timestamp
    let timestamp = Date().timeIntervalSince1970 * 1_000
      - (ProcessInfo.processInfo.systemUptime - frame.timestamp) * 1_000
    let pose = frame.camera.transform
    var cells = [Int](repeating: 0, count: 800)
    var zones = [Any](repeating: NSNull(), count: 5)
    var points = [[Double]]()
    var pointPixels = [SIMD2<Float>]()
    let columns = [pose.columns.0, pose.columns.1, pose.columns.2, pose.columns.3]
    var payload: [String: Any] = [
      "source": "arkit",
      "timeMs": timestamp,
      "sensorTimeMs": frame.timestamp * 1_000,
      "pose": columns.flatMap { [$0.x, $0.y, $0.z, $0.w] },
    ]
    if case .normal = frame.camera.trackingState, let depth = frame.sceneDepth {
      let cameraForward = SIMD2<Float>(-pose.columns.2.x, -pose.columns.2.z)
      if simd_length(cameraForward) > 0.4 {
        payload["forwardTrueHeading"] = (atan2(cameraForward.x, -cameraForward.y) * 180 / .pi + 360)
          .truncatingRemainder(dividingBy: 360)
      }
      let capture = recording && frame.timestamp - lastDepthTime >= 0.5
      if capture { lastDepthTime = frame.timestamp }
      payload["depth"] = project(depth, camera: frame.camera, cells: &cells, zones: &zones,
                                 points: &points, pointPixels: &pointPixels, capture: capture)
      if previewing {
        payload["depthPreview"] = encodeDepthPreview(depth)
        payload["smoothedDepthPreview"] = frame.smoothedSceneDepth.flatMap(encodeDepthPreview)
      }
      if simd_length(cameraForward) > 0.4 {
        retainRecentHits(pose: pose, forward: simd_normalize(cameraForward), time: frame.timestamp, cells: &cells)
      } else {
        recentHits.removeAll()
      }
    } else {
      recentHits.removeAll()
    }
    payload["zones"] = zones
    if previewing {
      payload["points"] = points
      payload["pointColors"] = sampleCameraRGB(frame.capturedImage, pixels: pointPixels)?.base64EncodedString()
    }
    payload["grid"] = ["width": 40, "height": 20, "cellM": 0.25, "cells": cells] as [String: Any]
    emit("onObservation", payload)
    if hazardEnabled, !hazardPending, frame.timestamp - lastHazardTime >= 0.65,
       case .normal = frame.camera.trackingState {
      hazardPending = true
      lastHazardTime = frame.timestamp
      let generation = hazardGeneration
      let run = runID
      let reportProgress = firstHazardPreview
      let backdrop = payload["depthPreview"] as? [String: Any]
      var capturedScan: [String: Any] = ["points": points]
      capturedScan["pointColors"] = payload["pointColors"]
      let scan = previewing && !points.isEmpty ? capturedScan : nil
      if reportProgress { emit("onHazardPreviewStatus", ["message": "Preparing the first model preview"]) }
      hazardQueue.async { [weak self, hazardModels = self.hazardModels] in
        var result = hazardModels.preview(frame, timeMs: timestamp, session: generation, progress: { message in
          guard reportProgress else { return }
          DispatchQueue.main.async { [weak self] in
            guard let self, self.runID == run, self.hazardEnabled, self.hazardGeneration == generation else { return }
            self.emit?("onHazardPreviewStatus", ["message": message])
          }
        }, partial: { result in
          guard reportProgress else { return }
          var frame = result
          frame["depthPreview"] = backdrop
          frame["scan"] = scan
          let preview = frame
          DispatchQueue.main.async { [weak self] in
            guard let self, self.runID == run, self.hazardEnabled, self.hazardGeneration == generation else { return }
            self.emit?("onHazardPreview", preview)
          }
        })
        result["depthPreview"] = backdrop
        result["scan"] = scan
        let preview = result
        DispatchQueue.main.async {
          guard let self else { return }
          self.hazardPending = false
          guard self.runID == run, self.hazardEnabled, self.hazardGeneration == generation else { return }
          self.firstHazardPreview = false
          self.emit?("onHazardPreview", preview)
        }
      }
    }
  }

  private func retainRecentHits(pose: simd_float4x4, forward: SIMD2<Float>, time: TimeInterval, cells: inout [Int]) {
    let origin = SIMD2<Float>(pose.columns.3.x, pose.columns.3.z)
    let right = SIMD2<Float>(-forward.y, forward.x)
    let observed = cells.indices.compactMap { index -> SIMD2<Float>? in
      guard cells[index] == 2 else { return nil }
      let x = (Float(index % 40) - 19.5) * 0.25
      let y = (19.5 - Float(index / 40)) * 0.25
      return origin + x * right + y * forward
    }
    recentHits.removeAll { time - $0.time > 0.25 }
    for hit in recentHits {
      for point in hit.points {
        let offset = point - origin
        let ahead = simd_dot(offset, forward)
        if let index = cell(simd_dot(offset, right), ahead), cells[index] == 0 { cells[index] = 2 }
      }
    }
    recentHits.append((time, observed))
  }

  private func encodeDepthPreview(_ depth: ARDepthData) -> [String: Any]? {
    let map = depth.depthMap
    guard let confidence = depth.confidenceMap,
          CVPixelBufferGetPixelFormatType(map) == kCVPixelFormatType_DepthFloat32,
          CVPixelBufferGetPixelFormatType(confidence) == kCVPixelFormatType_OneComponent8 else { return nil }
    let width = CVPixelBufferGetWidth(map)
    let height = CVPixelBufferGetHeight(map)
    guard width == CVPixelBufferGetWidth(confidence), height == CVPixelBufferGetHeight(confidence),
          CVPixelBufferLockBaseAddress(map, .readOnly) == kCVReturnSuccess else { return nil }
    defer { CVPixelBufferUnlockBaseAddress(map, .readOnly) }
    guard CVPixelBufferLockBaseAddress(confidence, .readOnly) == kCVReturnSuccess else { return nil }
    defer { CVPixelBufferUnlockBaseAddress(confidence, .readOnly) }
    guard let depths = CVPixelBufferGetBaseAddress(map),
          let qualities = CVPixelBufferGetBaseAddress(confidence) else { return nil }
    let depthStride = CVPixelBufferGetBytesPerRow(map)
    let confidenceStride = CVPixelBufferGetBytesPerRow(confidence)
    let step = max(1, (max(width, height) + 255) / 256)
    let previewWidth = (width + step - 1) / step
    let previewHeight = (height + step - 1) / step
    var samples = Data()
    samples.reserveCapacity(previewWidth * previewHeight * 2)
    for y in stride(from: 0, to: height, by: step) {
      for x in stride(from: 0, to: width, by: step) {
        let z = depths.load(fromByteOffset: y * depthStride + x * 4, as: Float.self)
        let quality = min(2, qualities.load(fromByteOffset: y * confidenceStride + x, as: UInt8.self))
        let cm = z.isFinite && z >= 0.01 && z <= 5 ? UInt16((z * 100).rounded()) : 0
        let sample = cm | (UInt16(quality) << 14)
        samples.append(UInt8(truncatingIfNeeded: sample))
        samples.append(UInt8(sample >> 8))
      }
    }
    return ["width": previewWidth, "height": previewHeight, "samples": samples.base64EncodedString()]
  }

  private func project(_ depth: ARDepthData, camera: ARCamera, cells: inout [Int], zones: inout [Any],
                       points: inout [[Double]], pointPixels: inout [SIMD2<Float>], capture: Bool) -> [String: Any]? {
    let map = depth.depthMap
    guard let confidence = depth.confidenceMap,
          CVPixelBufferGetPixelFormatType(map) == kCVPixelFormatType_DepthFloat32,
          CVPixelBufferGetPixelFormatType(confidence) == kCVPixelFormatType_OneComponent8 else { return nil }
    let width = CVPixelBufferGetWidth(map)
    let height = CVPixelBufferGetHeight(map)
    guard width == CVPixelBufferGetWidth(confidence), height == CVPixelBufferGetHeight(confidence) else { return nil }

    guard CVPixelBufferLockBaseAddress(map, .readOnly) == kCVReturnSuccess else { return nil }
    defer { CVPixelBufferUnlockBaseAddress(map, .readOnly) }
    guard CVPixelBufferLockBaseAddress(confidence, .readOnly) == kCVReturnSuccess else { return nil }
    defer { CVPixelBufferUnlockBaseAddress(confidence, .readOnly) }
    guard let depths = CVPixelBufferGetBaseAddress(map),
          let qualities = CVPixelBufferGetBaseAddress(confidence) else { return nil }
    let depthStride = CVPixelBufferGetBytesPerRow(map)
    let confidenceStride = CVPixelBufferGetBytesPerRow(confidence)
    let pose = camera.transform
    let cameraForward = SIMD2<Float>(-pose.columns.2.x, -pose.columns.2.z)
    guard simd_length(cameraForward) > 0.4 else { return nil }
    let forward = simd_normalize(cameraForward)
    let right = SIMD2<Float>(-forward.y, forward.x)
    let intrinsics = camera.intrinsics
    let scaleX = Float(camera.imageResolution.width) / Float(width)
    let scaleY = Float(camera.imageResolution.height) / Float(height)
    let maxPreviewPoints = 6_000
    let candidateCount = ((width + 1) / 3) * ((height + 1) / 3)
    let previewStride = max(1, (candidateCount + maxPreviewPoints - 1) / maxPreviewPoints)
    var support = [Int](repeating: 0, count: 5)
    var nearest = [Float](repeating: .infinity, count: 5)

    for y in stride(from: 1, to: height, by: 3) {
      for x in stride(from: 1, to: width, by: 3) {
        let quality = qualities.load(fromByteOffset: y * confidenceStride + x, as: UInt8.self)
        guard Int(quality) >= ARConfidenceLevel.medium.rawValue else { continue }
        let z = depths.load(fromByteOffset: y * depthStride + x * 4, as: Float.self)
        guard z.isFinite, z >= 0.15, z <= 5 else { continue }
        let u = (Float(x) + 0.5) * scaleX
        let v = (Float(y) + 0.5) * scaleY
        let ray = SIMD4<Float>((u - intrinsics[2][0]) / intrinsics[0][0] * z,
                               -(v - intrinsics[2][1]) / intrinsics[1][1] * z, -z, 0)
        let offset = pose * ray
        let horizontal = SIMD2<Float>(offset.x, offset.z)
        let lateral = simd_dot(horizontal, right)
        let ahead = simd_dot(horizontal, forward)
        let distance = simd_length(horizontal)
        if previewing, (x / 3 + y / 3) % previewStride == 0, points.count < maxPreviewPoints,
           ahead > 0, distance < 5, abs(offset.y) <= 3 {
          points.append([lateral, offset.y, ahead].map { (Double($0) * 100).rounded() / 100 })
          pointPixels.append(SIMD2((Float(x) + 0.5) / Float(width), (Float(y) + 0.5) / Float(height)))
        }
        // Height limits assume the camera is 1.2 m above the floor.
        guard ahead > 0, distance < 5, offset.y > -1.0, offset.y < 0.6 else { continue }
        let angle = atan2(lateral, ahead) * 180 / .pi
        guard abs(angle) <= 70 else { continue }
        let zone = angle <= -45 ? 0 : angle <= -15 ? 1 : angle < 15 ? 2 : angle < 45 ? 3 : 4
        support[zone] += 1
        nearest[zone] = min(nearest[zone], distance)

        var range: Float = 0.25
        while range < distance - 0.25 {
          let ratio = range / distance
          if let i = cell(lateral * ratio, ahead * ratio), cells[i] == 0 { cells[i] = 1 }
          range += 0.25
        }
        if let i = cell(lateral, ahead) { cells[i] = 2 }
      }
    }
    for zone in zones.indices where support[zone] >= 6 || nearest[zone] < 0.85 {
      zones[zone] = nearest[zone]
    }
    guard capture else { return nil }
    let sampleX = Array(stride(from: 0, to: width, by: 8))
    let sampleY = Array(stride(from: 0, to: height, by: 8))
    var meters = [Any]()
    var confidenceValues = [UInt8]()
    for y in sampleY {
      for x in sampleX {
        let value = depths.load(fromByteOffset: y * depthStride + x * 4, as: Float.self)
        meters.append(value.isFinite && value > 0 ? value as Any : NSNull())
        confidenceValues.append(qualities.load(fromByteOffset: y * confidenceStride + x, as: UInt8.self))
      }
    }
    return [
      "width": sampleX.count, "height": sampleY.count, "meters": meters, "confidence": confidenceValues,
      "intrinsics": [intrinsics[0][0] / scaleX / 8, intrinsics[1][1] / scaleY / 8,
                     (intrinsics[2][0] / scaleX - 0.5) / 8, (intrinsics[2][1] / scaleY - 0.5) / 8],
    ]
  }

  private func cell(_ lateral: Float, _ ahead: Float) -> Int? {
    let col = Int(floor(lateral / 0.25)) + 20
    let row = 19 - Int(floor(ahead / 0.25))
    guard (0..<40).contains(col), (0..<20).contains(row) else { return nil }
    return row * 40 + col
  }
}
