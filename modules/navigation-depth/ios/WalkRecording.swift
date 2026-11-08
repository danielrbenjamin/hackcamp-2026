import ARKit
import CoreGraphics
import CoreImage
import CoreVideo
import Foundation
import simd

final class WalkRecording {
  static let limit = 120
  private let id = UUID().uuidString
  private let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  private let context = CIContext()
  private var paths: [String] = []
  private var rows: [Data] = []
  private var captureError: Error?

  func capture(_ frame: ARFrame, timeMs: Double, predictions: [String: Any], epoch: Int) -> Int {
    guard rows.count < Self.limit, captureError == nil, let scene = frame.sceneDepth else { return rows.count }
    let previousPathCount = paths.count
    do {
      let key = "\(id)/\(rows.count)"
      let rgbPath = "rgb/\(key).jpg"
      let depthPath = "depth/\(key).f32"
      let image = CIImage(cvPixelBuffer: frame.capturedImage)
      guard let jpeg = context.jpegRepresentation(of: image, colorSpace: CGColorSpaceCreateDeviceRGB()) else {
        throw WalkError.capture
      }
      let depth = try depthRaster(scene.depthMap)
      let pose = frame.camera.transform
      let rotation = simd_quatf(pose).vector
      let position = pose.columns.3
      let intrinsics = frame.camera.intrinsics
      let time = Int64(timeMs.rounded())
      let root = "/Volumes/workspace/default/lantern_walks/"
      var row: [String: Any] = [
        "schema_version": 1, "source_type": "iphone_recording", "session_id": id,
        "consent": ["granted": true, "scope": "ml-walk-recording"],
        "frame_id": rows.count, "captured_at_ms": time, "rgb_ts_ms": time, "depth_ts_ms": time,
        "sensor_time_ms": frame.timestamp * 1000, "tracking_epoch": epoch,
        "rgb_path": root + rgbPath, "depth_path": root + depthPath,
        "rgb_width": CVPixelBufferGetWidth(frame.capturedImage), "rgb_height": CVPixelBufferGetHeight(frame.capturedImage),
        "depth_width": depth.width, "depth_height": depth.height, "depth_valid_fraction": depth.validFraction,
        "rgb_intrinsics": [intrinsics[0][0], intrinsics[1][1], intrinsics[2][0], intrinsics[2][1]],
        "camera_pose": ["tx_m": position.x, "ty_m": position.y, "tz_m": position.z,
                        "qx": rotation.x, "qy": rotation.y, "qz": rotation.z, "qw": rotation.w]
      ]
      try write(jpeg, at: rgbPath)
      try write(depth.data, at: depthPath)
      if let map = scene.confidenceMap {
        let path = "depth/\(key).confidence.u8"
        try write(try confidenceRaster(map, width: depth.width, height: depth.height), at: path)
        row["depth_confidence_path"] = root + path
      }
      let versions = predictions["versions"] as? [String: String] ?? [:]
      for (kind, field) in [("glass", "glass"), ("stairs", "stair"), ("person", "people")] {
        row["\(field)_model_version"] = versions[kind]
      }
      for mask in predictions["masks"] as? [[String: Any]] ?? [] {
        guard let kind = mask["kind"] as? String, let size = mask["size"] as? Int,
              let labels = mask["labels"] as? String, let data = Data(base64Encoded: labels),
              let probabilities = mask["probabilities"] as? [Float] else { continue }
        let field = kind == "glass" ? "glass" : "stair"
        let path = "masks/\(key).\(field).u8"
        try write(data, at: path)
        row["\(field)_mask_path"] = root + path
        row["\(field)_mask_size"] = size
        if kind == "glass" { row["glass_probability"] = probabilities[0] }
        else {
          row["stair_riser_probability"] = probabilities[0]
          row["stair_tread_probability"] = probabilities[1]
        }
      }
      if versions["person"] != nil {
        row["people"] = (predictions["people"] as? [[String: Any]] ?? []).map { person -> [String: Any] in
          var result: [String: Any] = [:]
          result["bbox_xywh"] = person["box"]
          result["confidence"] = person["confidence"]
          if let track = person["track_id"] as? String, let world = person["world"] as? [Float] {
            result["track_id"] = "\(epoch)-\(track)"
            result["coordinate_frame"] = "arkit_world"
            result["x_m"] = world[0]
            result["z_m"] = world[2]
          }
          return result
        }
      }
      var line = try JSONSerialization.data(withJSONObject: row, options: [.sortedKeys])
      line.append(10)
      rows.append(line)
    } catch {
      paths.removeLast(paths.count - previousPathCount)
      captureError = error
    }
    return rows.count
  }

  func finish() throws -> URL {
    defer { try? FileManager.default.removeItem(at: directory) }
    guard !rows.isEmpty else { throw captureError ?? WalkError.empty }
    try write(rows.reduce(into: Data()) { $0.append($1) }, at: "incoming/\(id).jsonl")
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("lantern-walk-\(id).zip")
    do {
      try writeWalkZIP(to: url, directory: directory, paths: paths)
      return url
    } catch {
      try? FileManager.default.removeItem(at: url)
      throw error
    }
  }

  private func write(_ data: Data, at path: String) throws {
    let url = directory.appendingPathComponent(path)
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try data.write(to: url, options: .atomic)
    paths.append(path)
  }
}

private enum WalkError: LocalizedError {
  case capture, empty
  var errorDescription: String? {
    switch self {
    case .capture: return "Could not encode an ARKit frame."
    case .empty: return "No walk frames were captured. Wait for iPhone LiDAR and try again."
    }
  }
}

private func depthRaster(_ buffer: CVPixelBuffer) throws -> (data: Data, width: Int, height: Int, validFraction: Double) {
  let width = CVPixelBufferGetWidth(buffer), height = CVPixelBufferGetHeight(buffer)
  guard CVPixelBufferGetPixelFormatType(buffer) == kCVPixelFormatType_DepthFloat32,
        CVPixelBufferLockBaseAddress(buffer, .readOnly) == kCVReturnSuccess else { throw WalkError.capture }
  defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
  guard let base = CVPixelBufferGetBaseAddress(buffer) else { throw WalkError.capture }
  let stride = CVPixelBufferGetBytesPerRow(buffer)
  var data = Data(count: width * height * 4)
  var valid = 0
  data.withUnsafeMutableBytes { (bytes: UnsafeMutableRawBufferPointer) in
    for y in 0..<height {
      for x in 0..<width {
        let depth = base.load(fromByteOffset: y * stride + x * 4, as: Float.self)
        let usable = depth.isFinite && depth > 0
        if usable { valid += 1 }
        bytes.storeBytes(of: (usable ? depth.bitPattern.littleEndian : UInt32(0)),
                         toByteOffset: (y * width + x) * 4, as: UInt32.self)
      }
    }
  }
  return (data, width, height, Double(valid) / Double(width * height))
}

private func confidenceRaster(_ buffer: CVPixelBuffer, width: Int, height: Int) throws -> Data {
  guard CVPixelBufferGetWidth(buffer) == width, CVPixelBufferGetHeight(buffer) == height,
        CVPixelBufferGetPixelFormatType(buffer) == kCVPixelFormatType_OneComponent8,
        CVPixelBufferLockBaseAddress(buffer, .readOnly) == kCVReturnSuccess else { throw WalkError.capture }
  defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
  guard let base = CVPixelBufferGetBaseAddress(buffer) else { throw WalkError.capture }
  let stride = CVPixelBufferGetBytesPerRow(buffer)
  var data = Data()
  for y in 0..<height { data.append(base.advanced(by: y * stride).assumingMemoryBound(to: UInt8.self), count: width) }
  return data
}
