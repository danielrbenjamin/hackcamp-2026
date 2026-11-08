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

  func bilinear(_ uv: SIMD2<Float>) -> Float {
    let x = max(0, min(Float(width - 1), uv.x * Float(width) - 0.5))
    let y = max(0, min(Float(height - 1), uv.y * Float(height) - 0.5))
    let left = Int(x), top = Int(y)
    let right = min(left + 1, width - 1), bottom = min(top + 1, height - 1)
    let dx = x - Float(left), dy = y - Float(top)
    func value(_ col: Int, _ row: Int) -> Float {
      let depth = depths[row * width + col]
      return depth.isFinite && depth > 0 ? depth : 0
    }
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
  private var previousPeople: [SIMD3<Float>] = []
  private var previousTime = -Double.infinity
  private var previousSession = -1

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

  func preview(_ frame: ARFrame, timeMs: Double, session: Int) -> [String: Any] {
    let started = ProcessInfo.processInfo.systemUptime
    let depth = frame.sceneDepth.flatMap(DepthSamples.init)
    var status: [String: String] = [:]
    var masks: [[String: Any]] = []
    for (kind, name, size, channels) in [("glass", "GlassSegmentation", 224, 5), ("stairs", "StairSegmentation", 384, 4)] {
      if let error = unavailable[kind] { status[kind] = error; continue }
      do {
        guard let depth else { throw ModelError.noDepth }
        let loaded = try model(name)
        let input = try tensor(frame.capturedImage, depth: depth, size: size, channels: channels)
        let features = try MLDictionaryFeatureProvider(dictionary: ["rgbd": MLFeatureValue(multiArray: input)])
        let prediction = try loaded.prediction(from: features)
        guard let output = prediction.featureValue(for: "logits")?.multiArrayValue,
              output.shape.map(\.intValue) == [1, kind == "glass" ? 1 : 3, size, size] else {
          throw ModelError.incompatible
        }
        masks.append(mask(output, kind: kind, size: size, depth: depth, camera: frame.camera))
        status[kind] = kind == "stairs" ? "Preview · LiDAR depth calibration unverified" : "Preview"
      } catch {
        status[kind] = message(error)
        if (error as? ModelError) == .missing { unavailable[kind] = status[kind] }
      }
    }
    var people: [[String: Any]] = []
    if let error = unavailable["person"] { status["person"] = error }
    else {
      do {
        people = try detectPeople(frame, depth: depth, session: session)
        status["person"] = "Preview"
      } catch {
        status["person"] = message(error)
        if (error as? ModelError) == .missing { unavailable["person"] = status["person"] }
      }
    }
    return ["timeMs": timeMs, "latencyMs": (ProcessInfo.processInfo.systemUptime - started) * 1_000,
            "models": status, "masks": masks, "people": people]
  }

  private func message(_ error: Error) -> String {
    if (error as? ModelError) == .missing { return "Package missing" }
    if (error as? ModelError) == .noDepth { return "Waiting for aligned RGB and depth" }
    if (error as? ModelError) == .incompatible { return "Unexpected model input or output" }
    return String(error.localizedDescription.prefix(180))
  }

  private func tensor(_ image: CVPixelBuffer, depth: DepthSamples, size: Int, channels: Int) throws -> MLMultiArray {
    let count = size * size
    let stairs = channels == 4
    let fit = stairs ? squareFit(width: CVPixelBufferGetWidth(image), height: CVPixelBufferGetHeight(image)) : SIMD2<Float>(repeating: 1)
    let center = SIMD2<Float>(repeating: 0.5)
    let pixels = (0..<count).map { i in
      let uv = SIMD2((Float(i % size) + 0.5) / Float(size), (Float(i / size) + 0.5) / Float(size))
      return (uv - center) / fit + center
    }
    let inside = pixels.map { $0.x >= 0 && $0.x < 1 && $0.y >= 0 && $0.y < 1 }
    guard let rgb = sampleCameraRGB(image, pixels: pixels, bilinear: stairs) else { throw ModelError.noDepth }
    let raw = pixels.enumerated().map { index, uv in
      stairs ? (inside[index] ? depth.bilinear(uv) : 0) : depth.depths[depth.index(uv)]
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
        // Match the final StairDataset transform in databricks/ml.py.
        let clipped = max(p01, min(p99, value))
        values[3 * count + i] = ((clipped - p01) / stairRange - 0.5) / 0.25
      } else {
        values[3 * count + i] = isValid ? min(1, value / p99) : 0
      }
      if channels == 5 { values[4 * count + i] = isValid ? 1 : 0 }
    }
    return input
  }

  private func mask(_ output: MLMultiArray, kind: String, size: Int, depth: DepthSamples, camera: ARCamera) -> [String: Any] {
    let previewSize = 96
    let fit = kind == "stairs" ? squareFit(width: Int(camera.imageResolution.width), height: Int(camera.imageResolution.height))
      : SIMD2<Float>(repeating: 1)
    let center = SIMD2<Float>(repeating: 0.5)
    var labels = Data()
    var points: [[Float]] = []
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
        if label != 0, x % 4 == 0, y % 4 == 0, points.count < 576,
           let world = depth.worldPoint(uv, camera: camera), let point = relativePoint(world, camera: camera) {
          points.append(point)
        }
      }
    }
    return ["kind": kind, "size": previewSize, "labels": labels.base64EncodedString(), "points": points]
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
    let dt = frame.timestamp - previousTime
    var unused = previousSession == session && dt > 0 && dt < 1.8 ? previousPeople : []
    var current: [SIMD3<Float>] = []
    let people: [[String: Any]] = candidates.sorted { $0.1 > $1.1 }.prefix(16).compactMap { candidate, confidence in
      let box = candidate.intersection(CGRect(x: 0, y: 0, width: 1, height: 1))
      guard !box.isNull, !box.isEmpty else { return nil }
      var item: [String: Any] = ["box": [box.minX, box.minY, box.width, box.height], "confidence": confidence]
      let columns: [CGFloat] = [0.35, 0.5, 0.65]
      let rows: [CGFloat] = [0.4, 0.55, 0.7]
      let samples = columns.flatMap { x in rows.compactMap { y in
        depth?.worldPoint(SIMD2(Float(box.minX + box.width * x), Float(box.minY + box.height * y)), camera: frame.camera)
      } }
      let origin = frame.camera.transform.columns.3
      let cameraPosition = SIMD3(origin.x, origin.y, origin.z)
      let sorted = samples.sorted { simd_distance($0, cameraPosition) < simd_distance($1, cameraPosition) }
      if sorted.count >= 3 {
        let world = sorted[sorted.count / 2]
        current.append(world)
        item["position"] = relativePoint(world, camera: frame.camera)
        if let index = unused.indices.min(by: { simd_distance(unused[$0], world) < simd_distance(unused[$1], world) }),
           simd_distance(unused[index], world) <= Float(dt) * 2 {
          let previous = unused.remove(at: index)
          let predicted = world + (world - previous) * Float(0.6 / dt)
          item["predictedPosition"] = relativePoint(predicted, camera: frame.camera)
        }
      }
      return item
    }
    previousSession = session
    previousTime = frame.timestamp
    previousPeople = current
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
