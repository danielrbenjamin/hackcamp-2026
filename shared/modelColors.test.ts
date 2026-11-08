import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DenseScan, ModelPreview } from './contracts.ts'
import { decodeDenseScan } from '../dashboard/denseScan.ts'
import { MODEL_COLORS, modelPointColors, glassBearing } from '../dashboard/modelColors.ts'

function fixture() {
  const samples = Buffer.alloc(4 * 2 * 8)
  for (let i = 0; i < 8; i++) {
    samples.writeFloatLE(i === 0 ? NaN : 2, i * 8)
    samples[i * 8 + 7] = 2
  }
  const scan: DenseScan = {
    width: 4, height: 2, timeMs: 10, intrinsics: [2, 2, 2, 1],
    basis: [1, 0, 0, 0, 1, 0, 0, 0, 1], cameraColor: false,
    samples: samples.toString('base64'),
  }
  const masks: ModelPreview['masks'] = [{
    kind: 'stairs', size: 2, labels: Buffer.from([1, 2, 0, 1]).toString('base64'), points: [],
  }]
  return { scan, masks, samples }
}

test('semantic colors follow raster coordinates across missing depth and rectangular scans', () => {
  const { scan, masks } = fixture()
  const decoded = decodeDenseScan(scan)
  assert.deepEqual(decoded.indices, [1, 2, 3, 4, 5, 6, 7])
  assert.deepEqual(modelPointColors(scan, decoded.indices, masks), [
    MODEL_COLORS.riser, MODEL_COLORS.tread, MODEL_COLORS.tread,
    undefined, undefined, MODEL_COLORS.riser, MODEL_COLORS.riser,
  ])
})

test('low and unavailable confidence retain geometry without semantic coloring', () => {
  const { scan, masks, samples } = fixture()
  samples[1 * 8 + 7] = 0
  samples[2 * 8 + 7] = 255
  samples[3 * 8 + 7] = 1
  scan.samples = samples.toString('base64')
  const decoded = decodeDenseScan(scan)
  assert.equal(decoded.points.length, 7)
  assert.deepEqual(modelPointColors(scan, decoded.indices, masks).slice(0, 3), [undefined, undefined, MODEL_COLORS.tread])
})

test('mask labels remain attached to the same measured returns when camera basis rotates', () => {
  const { scan, masks } = fixture()
  const original = decodeDenseScan(scan)
  const rotated = { ...scan, basis: [0, 0, -1, 0, 1, 0, 1, 0, 0] as DenseScan['basis'] }
  const decoded = decodeDenseScan(rotated)
  assert.notDeepEqual(decoded.points, original.points)
  assert.deepEqual(modelPointColors(rotated, decoded.indices, masks), modelPointColors(scan, original.indices, masks))
})

test('glass colors apply only to labelled returns and empty masks leave camera colors available', () => {
  const { scan, masks } = fixture()
  masks[0] = { ...masks[0], kind: 'glass', labels: Buffer.from([0, 1, 0, 0]).toString('base64') }
  assert.deepEqual(modelPointColors(scan, [1, 2], masks), [undefined, MODEL_COLORS.glass])
  assert.deepEqual(modelPointColors(scan, [1, 2], []), [undefined, undefined])
})

test('glass keeps a directional warning when every depth return is missing', () => {
  const { scan, masks, samples } = fixture()
  for (let i = 0; i < 8; i++) samples.writeFloatLE(NaN, i * 8)
  scan.samples = samples.toString('base64')
  masks[0] = { ...masks[0], kind: 'glass', labels: Buffer.from([0, 1, 0, 0]).toString('base64') }
  assert.equal(decodeDenseScan(scan).points.length, 0)
  const bearing = glassBearing(scan, masks)!
  assert.ok(Math.abs(bearing.left - Math.atan(0.5) * 180 / Math.PI) < 1e-6)
  assert.equal(bearing.left, bearing.right)
  assert.equal(glassBearing(scan, []), undefined)
  assert.equal(masks[0].points.length, 0)
})

test('glass bearing uses the pose basis when the image is rolled', () => {
  const { scan, masks } = fixture()
  masks[0] = { ...masks[0], kind: 'glass', labels: Buffer.from([0, 1, 0, 0]).toString('base64') }
  scan.basis = [0, 1, 0, -1, 0, 0, 0, 0, 1]
  assert.ok(glassBearing(scan, masks)!.right < 0)
})
