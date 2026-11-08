import Foundation

// Stored ZIP entries keep memory bounded to one sensor asset at a time.
func writeWalkZIP(to url: URL, directory: URL, paths: [String]) throws {
  guard FileManager.default.createFile(atPath: url.path, contents: nil) else { throw CocoaError(.fileWriteUnknown) }
  let output = try FileHandle(forWritingTo: url)
  defer { try? output.close() }
  let crcTable: [UInt32] = (0..<256).map { value in
    (0..<8).reduce(UInt32(value)) { crc, _ in
      (crc >> 1) ^ (crc & 1 == 0 ? 0 : 0xedb88320)
    }
  }
  var index = Data()
  for path in paths {
    let name = Data(path.utf8)
    let bytes = try Data(contentsOf: directory.appendingPathComponent(path))
    guard let offset = UInt32(exactly: try output.offset()), let length = UInt32(exactly: bytes.count),
          let nameLength = UInt16(exactly: name.count) else { throw CocoaError(.fileWriteUnknown) }
    let crc = bytes.reduce(UInt32.max) { crc, byte in
      (crc >> 8) ^ crcTable[Int((crc ^ UInt32(byte)) & 255)]
    } ^ UInt32.max
    var fields = Data()
    fields.little(UInt16(20)) // Required ZIP version
    fields.little(UInt16(0)) // Flags
    fields.little(UInt16(0)) // Stored
    fields.little(UInt16(0)) // Time
    fields.little(UInt16(33)) // 1980-01-01
    fields.little(crc)
    fields.little(length)
    fields.little(length)
    fields.little(nameLength)
    fields.little(UInt16(0)) // Extra length
    var header = Data()
    header.little(UInt32(0x04034b50))
    header.append(fields)
    header.append(name)
    try output.write(contentsOf: header)
    try output.write(contentsOf: bytes)
    index.little(UInt32(0x02014b50))
    index.little(UInt16(20))
    index.append(fields)
    index.little(UInt16(0)) // Comment length
    index.little(UInt16(0)) // Disk
    index.little(UInt16(0)) // Internal attributes
    index.little(UInt32(0)) // External attributes
    index.little(offset)
    index.append(name)
  }
  guard let offset = UInt32(exactly: try output.offset()), let length = UInt32(exactly: index.count),
        let count = UInt16(exactly: paths.count) else { throw CocoaError(.fileWriteUnknown) }
  try output.write(contentsOf: index)
  var end = Data()
  end.little(UInt32(0x06054b50))
  end.little(UInt16(0))
  end.little(UInt16(0))
  end.little(count)
  end.little(count)
  end.little(length)
  end.little(offset)
  end.little(UInt16(0))
  try output.write(contentsOf: end)
}

private extension Data {
  mutating func little<T: FixedWidthInteger>(_ value: T) {
    var encoded = value.littleEndian
    Swift.withUnsafeBytes(of: &encoded) { append(contentsOf: $0) }
  }
}
