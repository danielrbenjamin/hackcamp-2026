import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addScanFrame, scanPose, type ScanPoint } from './roomScan.ts'

test('room scan aligns returns after the phone translates and turns', () => {
  const start = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 1.2, 10, 1]
  const turned = [0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, 9, 1.2, 8, 1]
  const initial = scanPose(start, start, 'test')
  const next = scanPose(turned, start, 'test')
  assert.ok(initial && next)
  assert.deepEqual(next.origin, [-1, 0, 2])
  const voxels = new Map<string, ScanPoint>()
  addScanFrame(voxels, [[0, 0, 2]], initial, [0xffa040])
  addScanFrame(voxels, [[0, 0, 1]], next)
  assert.equal(voxels.size, 1)
  assert.equal([...voxels.values()][0].rgb, 0xffa040)
})
