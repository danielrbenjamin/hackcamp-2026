import CoreVideo
import Foundation

func sampleCameraRGB(_ image: CVPixelBuffer, pixels: [SIMD2<Float>], bilinear: Bool = false) -> Data? {
  let format = CVPixelBufferGetPixelFormatType(image)
  let fullRange = format == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
  guard !pixels.isEmpty, fullRange || format == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
        CVPixelBufferGetPlaneCount(image) == 2,
        CVPixelBufferLockBaseAddress(image, .readOnly) == kCVReturnSuccess else { return nil }
  defer { CVPixelBufferUnlockBaseAddress(image, .readOnly) }
  guard let luma = CVPixelBufferGetBaseAddressOfPlane(image, 0),
        let chroma = CVPixelBufferGetBaseAddressOfPlane(image, 1) else { return nil }
  let width = CVPixelBufferGetWidthOfPlane(image, 0)
  let height = CVPixelBufferGetHeightOfPlane(image, 0)
  let chromaWidth = CVPixelBufferGetWidthOfPlane(image, 1)
  let chromaHeight = CVPixelBufferGetHeightOfPlane(image, 1)
  let lumaStride = CVPixelBufferGetBytesPerRowOfPlane(image, 0)
  let chromaStride = CVPixelBufferGetBytesPerRowOfPlane(image, 1)
  var rgb = Data()
  rgb.reserveCapacity(pixels.count * 3)
  func channel(_ value: Float) -> UInt8 { UInt8(min(255, max(0, value.rounded()))) }
  func sample(_ buffer: UnsafeRawPointer, _ uv: SIMD2<Float>, _ w: Int, _ h: Int,
              _ stride: Int, _ bytes: Int, _ component: Int) -> Float {
    if !bilinear {
      return Float(buffer.load(fromByteOffset: Int(uv.y * Float(h)) * stride + Int(uv.x * Float(w)) * bytes + component,
                               as: UInt8.self))
    }
    let x = max(0, min(Float(w - 1), uv.x * Float(w) - 0.5))
    let y = max(0, min(Float(h - 1), uv.y * Float(h) - 0.5))
    let left = Int(x), top = Int(y)
    let right = min(left + 1, w - 1), bottom = min(top + 1, h - 1)
    let dx = x - Float(left), dy = y - Float(top)
    func value(_ col: Int, _ row: Int) -> Float {
      Float(buffer.load(fromByteOffset: row * stride + col * bytes + component, as: UInt8.self))
    }
    let a = value(left, top) * (1 - dx) + value(right, top) * dx
    let b = value(left, bottom) * (1 - dx) + value(right, bottom) * dx
    return a * (1 - dy) + b * dy
  }
  let scale: Float = fullRange ? 1 : 255 / 224
  for uv in pixels {
    let rawY = sample(luma, uv, width, height, lumaStride, 1, 0)
    let cb = (sample(chroma, uv, chromaWidth, chromaHeight, chromaStride, 2, 0) - 128) * scale
    let cr = (sample(chroma, uv, chromaWidth, chromaHeight, chromaStride, 2, 1) - 128) * scale
    let lumaValue = fullRange ? rawY : (rawY - 16) * 255 / 219
    rgb.append(channel(lumaValue + 1.402 * cr))
    rgb.append(channel(lumaValue - 0.344136 * cb - 0.714136 * cr))
    rgb.append(channel(lumaValue + 1.772 * cb))
  }
  return rgb
}

