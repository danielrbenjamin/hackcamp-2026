import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodeDenseScan, fillScanGaps, orientImagePoint, scanDisplayRotation, scanImagePoint, type ScanFrame } from '../dashboard/denseScan.ts'

test('Front display maps gravity up to the top in either portrait orientation', () => {
  const { scan } = frame(1000, 0, [1, 1, 1])
  assert.equal(scanDisplayRotation(scan), 0)
  const clockwise = scanDisplayRotation({ ...scan, basis: [0, -1, 0, 1, 0, 0, 0, 0, 1] })
  assert.equal(clockwise, 90)
  assert.deepEqual(orientImagePoint(0.25, 0.5, clockwise), [0.5, 0.25])
  const counterclockwise = scanDisplayRotation({ ...scan, basis: [0, 1, 0, -1, 0, 0, 0, 0, 1] })
  assert.equal(counterclockwise, -90)
  assert.deepEqual(orientImagePoint(0.75, 0.5, counterclockwise), [0.5, 0.25])
})

test('trajectory projection reverses the pitched camera basis and rejects points behind camera', () => {
  const scan = {
    width: 2, height: 1, timeMs: 1, intrinsics: [2, 2, 1, 0.5] as const,
    basis: [1, 0, 0, 0, 0.8, -0.6, 0, 0.6, 0.8], samples: '', cameraColor: false,
  }
  // Camera ray [0.5, 0, 2] becomes phone-relative [0.5, 1.2, 1.6].
  const uv = scanImagePoint(scan, [0.5, 1.2, 1.6])!
  assert.ok(Math.abs(uv[0] - 0.75) < 1e-6)
  assert.ok(Math.abs(uv[1] - 0.5) < 1e-6)
  assert.equal(scanImagePoint(scan, [0, -1.2, -1.6]), undefined)
})

test('dense scan preserves low-confidence and long-range returns at their original pixels', () => {
  const samples = Buffer.alloc(24)
  samples.writeFloatLE(0.1, 0)
  samples.set([32, 64, 128, 0], 4)
  samples.writeFloatLE(Number.NaN, 8)
  samples.writeFloatLE(7, 16)
  samples.set([3, 2, 1, 2], 20)
  const scan = decodeDenseScan({
    width: 3, height: 1, timeMs: 1, intrinsics: [1, 1, 1.5, 0.5],
    basis: [1, 0, 0, 0, 1, 0, 0, 0, 1], samples: samples.toString('base64'), cameraColor: true,
  })
  assert.deepEqual(scan.indices, [0, 2])
  assert.deepEqual(scan.points[1], [7, 0, 7])
  assert.deepEqual(scan.colors, [0x204080, 0x030201])
})

function frame(timeMs: number, right: number, values: number[], session = 'a'): ScanFrame {
  const samples = Buffer.alloc(values.length * 8)
  values.forEach((depth, index) => samples.writeFloatLE(depth, index * 8))
  const scan: ScanFrame['scan'] = {
    width: 3, height: 1, timeMs, intrinsics: [2, 2, 1.5, 0.5],
    basis: [1, 0, 0, 0, 1, 0, 0, 0, 1], samples: samples.toString('base64'), cameraColor: false,
    tracking: { session, position: [right, 0, 0], yaw: 0 },
  }
  return { scan, decoded: decodeDenseScan(scan) }
}

test('recent scan is reprojected into gaps without replacing current returns', () => {
  const current = frame(1000, 1, [0, 3, 0])
  const previous = frame(750, 0, [0, 2, 2])
  const fused = fillScanGaps(current, [previous])
  assert.equal(fused.filled, 1)
  assert.deepEqual(fused.indices, [1, 0])
  assert.deepEqual(fused.depths, [3, 2])
  assert.deepEqual(fused.points[1], [-1, 0, 2])
})

test('scan gaps stay empty after a tracking reset or when history expires', () => {
  const current = frame(2000, 0, [0, 0, 0])
  assert.equal(fillScanGaps(current, [frame(1900, 0, [2, 2, 2], 'b'), frame(499, 0, [2, 2, 2])]).filled, 0)
})

test('turning the phone moves a previous return to the correct image pixel', () => {
  const current = frame(1000, 0, [0, 0, 0])
  current.scan.tracking!.yaw = Math.atan(0.5)
  const fused = fillScanGaps(current, [frame(750, 0, [0, 2, 0])])
  assert.deepEqual(fused.indices, [0])
  assert.ok(fused.points[0][0] < 0)
})
