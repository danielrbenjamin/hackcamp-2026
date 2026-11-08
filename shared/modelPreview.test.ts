import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ModelPreview } from './contracts.ts'
import { validModelPreview } from '../dashboard/telemetry.ts'
import { decodeDenseScan } from '../dashboard/denseScan.ts'
import { MODEL_COLORS, modelPointColors } from '../dashboard/modelColors.ts'

function preview(size: number, kind: 'glass' | 'stairs' = 'glass'): ModelPreview {
  return {
    timeMs: 100, latencyMs: 50, models: { glass: 'Preview', stairs: 'Preview', person: 'Preview' },
    masks: [{ kind, size, labels: Buffer.alloc(size * size, 1).toString('base64'), points: [] }], people: [],
  }
}

test('relay accepts legacy and full-resolution masks including padded base64', () => {
  for (const size of [96, 224, 384]) assert.equal(validModelPreview(preview(size)), true)
  const value = preview(224)
  assert.ok(value.masks[0].labels.endsWith('=='))
  value.masks.push(preview(384, 'stairs').masks[0])
  assert.equal(validModelPreview(value), true)
})

test('relay rejects truncated or unsupported mask rasters', () => {
  const value = preview(224)
  value.masks[0].labels = value.masks[0].labels.slice(0, -4)
  assert.equal(validModelPreview(value), false)
  assert.equal(validModelPreview(preview(512)), false)
})

test('dense semantic frame colors every measured return without the 576-point cap', () => {
  const value = preview(384, 'stairs')
  const width = 256, height = 192
  const samples = Buffer.alloc(width * height * 8)
  for (let i = 0; i < width * height; i++) {
    samples.writeFloatLE(2, i * 8)
    samples[i * 8 + 7] = 2
  }
  value.denseScan = {
    width, height, timeMs: value.timeMs, intrinsics: [200, 200, 128, 96],
    basis: [1, 0, 0, 0, 1, 0, 0, 0, 1], samples: samples.toString('base64'), cameraColor: false,
  }
  assert.equal(validModelPreview(value), true)
  const decoded = decodeDenseScan(value.denseScan)
  const colors = modelPointColors(value.denseScan, decoded.indices, value.masks)
  assert.equal(colors.filter(color => color === MODEL_COLORS.riser).length, 49_152)
  value.denseScan.timeMs++
  assert.equal(validModelPreview(value), false, 'cannot combine a mask with a different depth frame')
})

test('intrinsics and a rolled camera basis reconstruct known 3D geometry', () => {
  const samples = Buffer.alloc(2 * 8)
  for (let i = 0; i < 2; i++) samples.writeFloatLE(2, i * 8)
  const decoded = decodeDenseScan({
    width: 2, height: 1, timeMs: 1, intrinsics: [2, 2, 1, 0.5],
    // Camera right points up; camera up points left, as after a 90-degree roll.
    basis: [0, 1, 0, -1, 0, 0, 0, 0, 1], samples: samples.toString('base64'), cameraColor: false,
  })
  assert.deepEqual(decoded.points, [[0, -0.5, 2], [0, 0.5, 2]])
})
