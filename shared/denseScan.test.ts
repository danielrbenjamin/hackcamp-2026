import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodeDenseScan, fillScanGaps, type ScanFrame } from '../dashboard/denseScan.ts'

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
