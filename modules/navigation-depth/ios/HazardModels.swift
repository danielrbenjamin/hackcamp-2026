import ARKit
import CoreGraphics
import CoreML
import CoreVideo
import Foundation
import Vision
import simd

private enum ModelError: Error, Equatable { case missing, incompatible, noDepth }

private func squareFit(width: Int, height: Int) -> SIMD2<Float> {
  let longest = Float(max(1, max(width, height)))
  return SIMD2(Float(width) / longest, Float(height) / longest)
}

private struct DepthSamples {
  let width: Int
  let height: Int
  let depths: [Float]
  let confidence: [UInt8]

  init?(_ depth: ARDepthData) {
    let map = depth.depthMap
    guard let quality = depth.confidenceMap,
          CVPixelBufferGetPixelFormatType(map) == kCVPixelFormatType_DepthFloat32,
          CVPixelBufferGetPixelFormatType(quality) == kCVPixelFormatType_OneComponent8,
          CVPixelBufferLockBaseAddress(map, .readOnly) == kCVReturnSuccess else { return nil }
    defer { CVPixelBufferUnlockBaseAddress(map, .readOnly) }
    guard CVPixelBufferLockBaseAddress(quality, .readOnly) == kCVReturnSuccess else { return nil }
    defer { CVPixelBufferUnlockBaseAddress(quality, .readOnly) }
    let w = CVPixelBufferGetWidth(map)
    let h = CVPixelBufferGetHeight(map)
    guard w > 0, h > 0, w == CVPixelBufferGetWidth(quality), h == CVPixelBufferGetHeight(quality),
          let meters = CVPixelBufferGetBaseAddress(map), let levels = CVPixelBufferGetBaseAddress(quality) else { return nil }
    let meterStride = CVPixelBufferGetBytesPerRow(map)
    let qualityStride = CVPixelBufferGetBytesPerRow(quality)
    width = w
    height = h
    depths = (0..<h).flatMap { y in (0..<w).map { x in
      meters.load(fromByteOffset: y * meterStride + x * 4, as: Float.self)
    } }
    confidence = (0..<h).flatMap { y in (0..<w).map { x in
      levels.load(fromByteOffset: y * qualityStride + x, as: UInt8.self)
    } }
  }

  func index(_ uv: SIMD2<Float>) -> Int {
    let x = min(width - 1, max(0, Int(uv.x * Float(width))))
    let y = min(height - 1, max(0, Int(uv.y * Float(height))))
    return y * width + x
  }

  func stairDepths(using smoothed: DepthSamples?) -> (values: [Float], recovered: Int, missing: Int) {
    let fallback = smoothed.flatMap { $0.width == width && $0.height == height ? $0 : nil }
    var recovered = 0
    var missing = 0
    let values = depths.enumerated().map { index, depth -> Float in
      if depth.isFinite && depth > 0 { return depth }
      if let fallback, fallback.confidence[index] >= 1 {
        let candidate = fallback.depths[index]
        if candidate.isFinite && candidate > 0 {
          recovered += 1
          return candidate
        }
      }
      missing += 1
      return 0
    }
    return (values, recovered, missing)
  }

  func bilinear(_ uv: SIMD2<Float>, values: [Float]) -> Float {
    let x = max(0, min(Float(width - 1), uv.x * Float(width) - 0.5))
    let y = max(0, min(Float(height - 1), uv.y * Float(height) - 0.5))
    let left = Int(x), top = Int(y)
    let right = min(left + 1, width - 1), bottom = min(top + 1, height - 1)
    let dx = x - Float(left), dy = y - Float(top)
    func value(_ col: Int, _ row: Int) -> Float { values[row * width + col] }
    let a = value(left, top) * (1 - dx) + value(right, top) * dx
    let b = value(left, bottom) * (1 - dx) + value(right, bottom) * dx
    return a * (1 - dy) + b * dy
  }

  func worldPoint(_ uv: SIMD2<Float>, camera: ARCamera) -> SIMD3<Float>? {
    let i = index(uv)
    let z = depths[i]
    guard confidence[i] >= 1, z.isFinite, z >= 0.15, z <= 5 else { return nil }
    let k = camera.intrinsics
    let x = (Float(i % width) + 0.5) / Float(width) * Float(camera.imageResolution.width)
    let y = (Float(i / width) + 0.5) / Float(height) * Float(camera.imageResolution.height)
    let cameraPoint = SIMD4((x - k[2][0]) * z / k[0][0], -(y - k[2][1]) * z / k[1][1], -z, 1)
    let point = camera.transform * cameraPoint
    return SIMD3(point.x, point.y, point.z)
  }
}

private func relativePoint(_ world: SIMD3<Float>, camera: ARCamera) -> [Float]? {
  let pose = camera.transform
  let forward = SIMD2(-pose.columns.2.x, -pose.columns.2.z)
  guard simd_length(forward) > 0.4 else { return nil }
  let heading = simd_normalize(forward)
  let right = SIMD2(-heading.y, heading.x)
  let offset = world - SIMD3(pose.columns.3.x, pose.columns.3.y, pose.columns.3.z)
  let ground = SIMD2(offset.x, offset.z)
  return [simd_dot(ground, right), offset.y, simd_dot(ground, heading)]
}

final class HazardModels {
  private var models: [String: MLModel] = [:]
  private var unavailable: [String: String] = [:]
  private var personModel: VNCoreMLModel?
  private let personTrajectory = PersonTrajectory()

  private func model(_ name: String) throws -> MLModel {
    if let cached = models[name] { return cached }
    let module = Bundle(for: NavigationDepthModule.self)
    guard let url = module.url(forResource: "NavigationModels", withExtension: "bundle")
      ?? Bundle.main.url(forResource: "NavigationModels", withExtension: "bundle"),
      let bundle = Bundle(url: url) else { throw ModelError.missing }
    let compiled: URL
    if let artifact = bundle.url(forResource: name, withExtension: "mlmodelc") {
      compiled = artifact
    } else if let package = bundle.url(forResource: name, withExtension: "mlpackage") {
      compiled = try MLModel.compileModel(at: package)
    } else { throw ModelError.missing }
    let loaded = try MLModel(contentsOf: compiled)
    models[name] = loaded
    return loaded
  }

  func preview(_ frame: ARFrame, timeMs: Double, session: Int, progress: (String) -> Void,
               partial: ([String: Any]) -> Void) -> [String: Any] {
    let started = ProcessInfo.processInfo.systemUptime
    let depth = frame.sceneDepth.flatMap(DepthSamples.init)
    var status = ["glass": "Waiting", "stairs": "Waiting", "person": "Waiting"]
    var masks: [[String: Any]] = []
    var people: [[String: Any]] = []
    func snapshot(partial: Bool) -> [String: Any] {
      ["timeMs": timeMs, "latencyMs": (ProcessInfo.processInfo.systemUptime - started) * 1_000,
       "models": status, "masks": masks, "people": people, "partial": partial]
    }
    if let error = unavailable["person"] { status["person"] = error }
    else {
      do {
        progress("Running person model")
        people = try detectPeople(frame, depth: depth, session: session)
        status["person"] = "Preview"
      } catch {
        status["person"] = message(error)
        if (error as? ModelError) == .missing { unavailable["person"] = status["person"] }
      }
    }
    partial(snapshot(partial: true))
    for (kind, name, size, channels) in [("glass", "GlassSegmentation", 224, 5), ("stairs", "StairSegmentation", 384, 4)] {
      if let error = unavailable[kind] { status[kind] = error; continue }
      do {
        guard let depth else { throw ModelError.noDepth }
        progress("Loading \(kind) model")
        let loaded = try model(name)
        progress("Running \(kind) model")
        let stairDepth = kind == "stairs" ? depth.stairDepths(using: frame.smoothedSceneDepth.flatMap(DepthSamples.init)) : nil
        let input = try tensor(frame.capturedImage, depth: depth, size: size, channels: channels, stairDepth: stairDepth?.values)
        let features = try MLDictionaryFeatureProvider(dictionary: ["rgbd": MLFeatureValue(multiArray: input)])
        let prediction = try loaded.prediction(from: features)
        guard let output = prediction.featureValue(for: "logits")?.multiArrayValue,
              output.shape.map(\.intValue) == [1, kind == "glass" ? 1 : 3, size, size] else {
          throw ModelError.incompatible
        }
        masks.append(mask(output, kind: kind, size: size, camera: frame.camera))
        if let stairDepth {
          let total = Double(depth.width * depth.height)
          let recovered = Int((100 * Double(stairDepth.recovered) / total).rounded())
          let missing = Int((100 * Double(stairDepth.missing) / total).rounded())
          status[kind] = "Preview · \(recovered)% depth recovered · \(missing)% missing"
        } else {
          status[kind] = "Preview"
        }
      } catch {
        status[kind] = message(error)
        if (error as? ModelError) == .missing { unavailable[kind] = status[kind] }
      }
      if kind == "glass" { partial(snapshot(partial: true)) }
    }
    return snapshot(partial: false)
  }

  private func message(_ error: Error) -> String {
    if (error as? ModelError) == .missing { return "Package missing" }
    if (error as? ModelError) == .noDepth { return "Waiting for aligned RGB and depth" }
    if (error as? ModelError) == .incompatible { return "Unexpected model input or output" }
    return String(error.localizedDescription.prefix(180))
  }

  private func tensor(_ image: CVPixelBuffer, depth: DepthSamples, size: Int, channels: Int, stairDepth: [Float]?) throws -> MLMultiArray {
    let count = size * size
    let stairs = channels == 4
    let fit = stairs ? squareFit(width: CVPixelBufferGetWidth(image), height: CVPixelBufferGetHeight(image)) : SIMD2<Float>(repeating: 1)
    let center = SIMD2<Float>(repeating: 0.5)
    let pixels = (0..<count).map { i in
      let uv = SIMD2((Float(i % size) + 0.5) / Float(size), (Float(i / size) + 0.5) / Float(size))
      return (uv - center) / fit + center
    }
    let inside = pixels.map { $0.x >= 0 && $0.x < 1 && $0.y >= 0 && $0.y < 1 }
    // Both training loaders resize RGB with bilinear interpolation. Glass depth
    // deliberately remains nearest-neighbour to preserve its validity channel.
    guard let rgb = sampleCameraRGB(image, pixels: pixels, bilinear: true) else { throw ModelError.noDepth }
    let raw = pixels.enumerated().map { index, uv in
      if let stairDepth { return inside[index] ? depth.bilinear(uv, values: stairDepth) : 0 }
      return depth.depths[depth.index(uv)]
    }
    let valid = raw.filter { $0.isFinite && $0 > 0 }.sorted()
    func percentile(_ fraction: Double, fallback: Float) -> Float {
      guard !valid.isEmpty else { return fallback }
      let rank = Double(valid.count - 1) * fraction
      let lower = Int(rank)
      let upper = Int(rank.rounded(.up))
      return valid[lower] + (valid[upper] - valid[lower]) * Float(rank - Double(lower))
    }
    let p99 = percentile(0.99, fallback: 1)
    let p01 = stairs ? percentile(0.01, fallback: 0) : 0
    let stairRange = max(p99 - p01, 1e-6)
    let input = try MLMultiArray(shape: [1, NSNumber(value: channels), NSNumber(value: size), NSNumber(value: size)], dataType: .float32)
    let values = input.dataPointer.bindMemory(to: Float.self, capacity: channels * count)
    let mean: [Float] = [0.485, 0.456, 0.406]
    let deviation: [Float] = [0.229, 0.224, 0.225]
    for i in 0..<count {
      for channel in 0..<3 {
        let color = inside[i] ? Float(rgb[i * 3 + channel]) / 255 : 0
        values[channel * count + i] = (color - mean[channel]) / deviation[channel]
      }
      let value = raw[i]
      let isValid = value.isFinite && value > 0
      if stairs {
        // Match the final StairDataset transform in databricks/stairs.py.
        let clipped = max(p01, min(p99, value))
        values[3 * count + i] = ((clipped - p01) / stairRange - 0.5) / 0.25
      } else {
        values[3 * count + i] = isValid ? min(1, value / max(p99, 1e-6)) : 0
      }
      if channels == 5 { values[4 * count + i] = isValid ? 1 : 0 }
    }
    return input
  }

  private func mask(_ output: MLMultiArray, kind: String, size: Int, camera: ARCamera) -> [String: Any] {
    // Retain model resolution; the dashboard labels the existing dense scan.
    let previewSize = size
    let fit = kind == "stairs" ? squareFit(width: Int(camera.imageResolution.width), height: Int(camera.imageResolution.height))
      : SIMD2<Float>(repeating: 1)
    let center = SIMD2<Float>(repeating: 0.5)
    var labels = Data()
    for y in 0..<previewSize {
      for x in 0..<previewSize {
        let uv = SIMD2((Float(x) + 0.5) / Float(previewSize), (Float(y) + 0.5) / Float(previewSize))
        let modelUV = (uv - center) * fit + center
        let row = NSNumber(value: Int(modelUV.y * Float(size)))
        let col = NSNumber(value: Int(modelUV.x * Float(size)))
        let first = output[[0, 0, row, col]].floatValue
        var label: UInt8 = 0
        if kind == "glass" {
          // A logit of zero is the sigmoid threshold of 0.5.
          if first.isFinite && first >= 0 { label = 1 }
        } else {
          let riser = output[[0, 1, row, col]].floatValue
          let tread = output[[0, 2, row, col]].floatValue
          if riser > first || tread > first { label = tread > riser ? 2 : 1 }
        }
        labels.append(label)
      }
    }
    return ["kind": kind, "size": previewSize, "labels": labels.base64EncodedString(), "points": [[Float]]()]
  }

  private func detectPeople(_ frame: ARFrame, depth: DepthSamples?, session: Int) throws -> [[String: Any]] {
    if personModel == nil { personModel = try VNCoreMLModel(for: model("PersonDetection")) }
    guard let personModel else { throw ModelError.incompatible }
    let request = VNCoreMLRequest(model: personModel)
    request.imageCropAndScaleOption = .scaleFill
    try VNImageRequestHandler(cvPixelBuffer: frame.capturedImage, orientation: .up, options: [:]).perform([request])
    let results = request.results ?? []
    let candidates: [(CGRect, Float)]
    if let objects = results as? [VNRecognizedObjectObservation] {
      candidates = objects.compactMap { object in
        guard let label = object.labels.first, label.identifier.lowercased() == "person",
              label.confidence.isFinite, label.confidence >= 0.25, label.confidence <= 1 else { return nil }
        let box = object.boundingBox
        return (CGRect(x: box.minX, y: 1 - box.maxY, width: box.width, height: box.height), label.confidence)
      }
    } else {
      candidates = try personFeatures(results)
    }
    var current: [SIMD3<Float>] = []
    var locatedIndices: [Int] = []
    var people: [[String: Any]] = []
    for (candidate, confidence) in candidates.sorted(by: { $0.1 > $1.1 }).prefix(16) {
      let box = candidate.intersection(CGRect(x: 0, y: 0, width: 1, height: 1))
      guard !box.isNull, !box.isEmpty else { continue }
      var item: [String: Any] = ["box": [box.minX, box.minY, box.width, box.height], "confidence": confidence]
      let columns: [CGFloat] = [0.35, 0.5, 0.65]
      let rows: [CGFloat] = [0.4, 0.55, 0.7]
      let samples = columns.flatMap { x in rows.compactMap { y in
        depth?.worldPoint(SIMD2(Float(box.minX + box.width * x), Float(box.minY + box.height * y)), camera: frame.camera)
      } }
      let origin = frame.camera.transform.columns.3
      let cameraPosition = SIMD3(origin.x, origin.y, origin.z)
      let sorted = samples.sorted { simd_distance($0, cameraPosition) < simd_distance($1, cameraPosition) }
      if sorted.count >= 3, let position = relativePoint(sorted[sorted.count / 2], camera: frame.camera) {
        let world = sorted[sorted.count / 2]
        locatedIndices.append(people.count)
        current.append(world)
        item["position"] = position
      }
      people.append(item)
    }
    let tracks = personTrajectory.update(current, time: frame.timestamp, session: session)
    for (index, personIndex) in locatedIndices.enumerated() {
      guard let track = tracks[index] else { continue }
      people[personIndex]["trackId"] = track.id
      people[personIndex]["history"] = track.history.compactMap { relativePoint($0.position, camera: frame.camera) }
        .filter { $0.allSatisfy { $0.isFinite && abs($0) <= 10 } }
      let trajectory = track.future.compactMap { relativePoint($0, camera: frame.camera) }
      if let predicted = trajectory.last {
        people[personIndex]["predictedPosition"] = predicted
        people[personIndex]["trajectory"] = trajectory
        people[personIndex]["predictionHorizonMs"] = 600
      }
    }
    return people
  }

  private func personFeatures(_ results: [VNObservation]) throws -> [(CGRect, Float)] {
    let features = results.compactMap { $0 as? VNCoreMLFeatureValueObservation }
    guard let coordinates = features.first(where: { $0.featureName == "coordinates" })?.featureValue.multiArrayValue,
          let confidence = features.first(where: { $0.featureName == "confidence" })?.featureValue.multiArrayValue,
          coordinates.shape.count == 2, confidence.shape.count == 2,
          coordinates.shape[1].intValue == 4, confidence.shape[1].intValue == 80,
          coordinates.shape[0] == confidence.shape[0] else { throw ModelError.incompatible }
    return (0..<coordinates.shape[0].intValue).compactMap { index in
      let row = NSNumber(value: index)
      let score = confidence[[row, 0]].floatValue
      guard score.isFinite, score >= 0.25, score <= 1,
            (1..<80).allSatisfy({ confidence[[row, NSNumber(value: $0)]].floatValue <= score }) else { return nil }
      let values = (0..<4).map { coordinates[[row, NSNumber(value: $0)]].doubleValue }
      guard values.allSatisfy(\.isFinite), values[2] > 0, values[3] > 0 else { return nil }
      return (CGRect(x: CGFloat(values[0] - values[2] / 2), y: CGFloat(values[1] - values[3] / 2),
                     width: CGFloat(values[2]), height: CGFloat(values[3])), score)
    }
  }
}

// Diagnostic tracker; all state is in ARKit world metres on the serial hazard queue.
final class PersonTrajectory {
  struct Sample {
    let time: Double
    let position: SIMD3<Float>
  }

  struct Track {
    let id: Int
    var position: SIMD3<Float>
    var velocity = SIMD3<Float>(repeating: 0)
    var time: Double
    var observations = 1
    var history: [Sample]

    var future: [SIMD3<Float>] {
      guard observations >= 2 else { return [] }
      return [Float(0.2), 0.4, 0.6].map { position + velocity * $0 }
    }
  }

  private var tracks: [Track] = []
  private var session: Int?
  private var lastTime = -Double.infinity
  private var nextID = 1
  private let maxGap = 1.8

  func update(_ positions: [SIMD3<Float>], time: Double, session: Int) -> [Int: Track] {
    guard time.isFinite else { tracks.removeAll(); return [:] }
    if self.session != session || time <= lastTime || time - lastTime > maxGap {
      tracks.removeAll()
    }
    self.session = session
    lastTime = time
    tracks.removeAll { time - $0.time > maxGap }

    // Sort all candidate pairs together so confidence ordering cannot steal the
    // nearest match. Each observation and track can be consumed only once.
    var pairs: [(distance: Float, track: Int, observation: Int)] = []
    for (index, track) in tracks.enumerated() {
      let dt = Float(time - track.time)
      let expected = track.position + track.velocity * dt
      for (observation, point) in positions.enumerated() {
        guard point.x.isFinite, point.y.isFinite, point.z.isFinite else { continue }
        let distance = simd_distance(expected, point)
        let displacement = simd_distance(track.position, point)
        if distance <= min(1.5, 0.4 + 1.5 * dt), displacement <= 0.25 + 3 * dt {
          pairs.append((distance, index, observation))
        }
      }
    }
    pairs.sort { $0.distance < $1.distance }
    var usedTracks = Set<Int>()
    var result: [Int: Track] = [:]
    for pair in pairs {
      guard !usedTracks.contains(pair.track), result[pair.observation] == nil else { continue }
      var track = tracks[pair.track]
      let dt = Float(time - track.time)
      guard dt >= 0.1 else { continue }
      var measured = (positions[pair.observation] - track.position) / dt
      measured.y = 0 // Torso depth jitter is not vertical walking velocity.
      let speed = simd_length(measured)
      if speed > 3 { measured *= 3 / speed }
      let weight: Float = track.observations == 1 ? 1 : 0.45
      track.velocity = track.velocity * (1 - weight) + measured * weight
      track.position = positions[pair.observation]
      track.time = time
      track.observations += 1
      track.history.append(Sample(time: time, position: track.position))
      track.history = Array(track.history.filter { time - $0.time <= 4 }.suffix(8))
      tracks[pair.track] = track
      usedTracks.insert(pair.track)
      result[pair.observation] = track
    }
    for (index, point) in positions.enumerated() where result[index] == nil {
      guard point.x.isFinite, point.y.isFinite, point.z.isFinite else { continue }
      let track = Track(id: nextID, position: point, time: time,
                        history: [Sample(time: time, position: point)])
      nextID += 1
      tracks.append(track)
      result[index] = track
    }
    // Bound retained unmatched tracks. They are never emitted without a current detection.
    tracks = Array(tracks.sorted { $0.time > $1.time }.prefix(32))
    return result
  }
}
