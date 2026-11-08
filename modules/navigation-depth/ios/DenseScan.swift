import ARKit
import CoreVideo
import Foundation
import simd

func denseScan(_ frame: ARFrame, timeMs: Double, origin: simd_float4x4? = nil, session: String = "") -> [String: Any]? {
  guard let depth = frame.sceneDepth else { return nil }
  let map = depth.depthMap
  let width = CVPixelBufferGetWidth(map)
  let height = CVPixelBufferGetHeight(map)
  guard width > 0, height > 0, width * height <= 512 * 512,
        CVPixelBufferGetPixelFormatType(map) == kCVPixelFormatType_DepthFloat32,
        CVPixelBufferLockBaseAddress(map, .readOnly) == kCVReturnSuccess else { return nil }
  defer { CVPixelBufferUnlockBaseAddress(map, .readOnly) }
  guard let base = CVPixelBufferGetBaseAddress(map) else { return nil }
  let confidence = depth.confidenceMap.flatMap { buffer in
    CVPixelBufferGetWidth(buffer) == width && CVPixelBufferGetHeight(buffer) == height &&
      CVPixelBufferGetPixelFormatType(buffer) == kCVPixelFormatType_OneComponent8 &&
      CVPixelBufferLockBaseAddress(buffer, .readOnly) == kCVReturnSuccess ? buffer : nil
  }
  defer { if let confidence { CVPixelBufferUnlockBaseAddress(confidence, .readOnly) } }
  let qualities = confidence.flatMap { CVPixelBufferGetBaseAddress($0) }
  let qualityStride = confidence.map { CVPixelBufferGetBytesPerRow($0) } ?? 0
  let stride = CVPixelBufferGetBytesPerRow(map)
  let pixels = (0..<(width * height)).map { index in
    SIMD2((Float(index % width) + 0.5) / Float(width), (Float(index / width) + 0.5) / Float(height))
  }
  let rgb = sampleCameraRGB(frame.capturedImage, pixels: pixels)
  var data = Data(count: width * height * 8)
  data.withUnsafeMutableBytes { (bytes: UnsafeMutableRawBufferPointer) in
    for y in 0..<height {
      for x in 0..<width {
        let i = y * width + x
        let depth = base.load(fromByteOffset: y * stride + x * 4, as: Float.self)
        bytes.storeBytes(of: depth.bitPattern.littleEndian, toByteOffset: i * 8, as: UInt32.self)
        if let rgb {
          for channel in 0..<3 { bytes[i * 8 + 4 + channel] = rgb[i * 3 + channel] }
        }
        bytes[i * 8 + 7] = qualities?.load(fromByteOffset: y * qualityStride + x, as: UInt8.self) ?? 255
      }
    }
  }
  let camera = frame.camera
  let pose = camera.transform
  let forward = SIMD2(-pose.columns.2.x, -pose.columns.2.z)
  let heading = simd_length(forward) > 0.001 ? simd_normalize(forward) : SIMD2<Float>(0, -1)
  let right = SIMD2(-heading.y, heading.x)
  let basis = [pose.columns.0, pose.columns.1, -pose.columns.2].flatMap { axis -> [Float] in
    let ground = SIMD2(axis.x, axis.z)
    return [simd_dot(ground, right), axis.y, simd_dot(ground, heading)]
  }
  let k = camera.intrinsics
  let scaleX = Float(width) / Float(camera.imageResolution.width)
  let scaleY = Float(height) / Float(camera.imageResolution.height)
  var result: [String: Any] = ["width": width, "height": height, "timeMs": timeMs,
          "intrinsics": [k[0][0] * scaleX, k[1][1] * scaleY, k[2][0] * scaleX, k[2][1] * scaleY],
          "basis": basis, "samples": data.base64EncodedString(), "cameraColor": rgb != nil]
  if let origin, case .normal = camera.trackingState, simd_length(forward) > 0.1 {
    let initialForward = SIMD2(-origin.columns.2.x, -origin.columns.2.z)
    if simd_length(initialForward) > 0.1 {
      let axis = simd_normalize(initialForward)
      let initialRight = SIMD2(-axis.y, axis.x)
      let delta = pose.columns.3 - origin.columns.3
      let ground = SIMD2(delta.x, delta.z)
      let yaw = atan2(simd_dot(heading, initialRight), simd_dot(heading, axis))
      result["tracking"] = ["session": session,
                            "position": [simd_dot(ground, initialRight), delta.y, simd_dot(ground, axis)],
                            "yaw": yaw] as [String: Any]
    }
  }
  return result
}
