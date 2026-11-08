import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ModelPreview } from './contracts.ts'
import { validModelPreview, validPersonPreview } from '../dashboard/telemetry.ts'
import { decodeDenseScan } from '../dashboard/denseScan.ts'
import { MODEL_COLORS, modelPointColors } from '../dashboard/modelColors.ts'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

const detection: ModelPreview['people'][number] = { box: [0.1, 0.2, 0.3, 0.6], confidence: 0.9 }
const tracked: ModelPreview['people'][number] = {
  ...detection, trackId: 4, position: [0, 0, 2], history: [[-0.2, 0, 2], [0, 0, 2]],
  predictedPosition: [0.6, 0, 2], trajectory: [[0.2, 0, 2], [0.4, 0, 2], [0.6, 0, 2]],
  predictionHorizonMs: 600,
}

test('accepts unlocated 2D detections, legacy predictions and native trajectory payloads', () => {
  assert.equal(validPersonPreview(detection), true)
  assert.equal(validPersonPreview({ ...detection, position: [0, 0, 2], predictedPosition: [1, 0, 2] }), true)
  assert.equal(validPersonPreview(tracked), true)
})

test('rejects trajectories without measured depth, unbounded history and malformed points', () => {
  for (const invalid of [
    { ...tracked, position: undefined },
    { ...tracked, history: Array(9).fill([0, 0, 2]) },
    { ...tracked, trajectory: [[NaN, 0, 2], [0, 0, 2], [0, 0, 2]] },
    { ...tracked, trajectory: [[0, 0, 2]] },
    { ...tracked, predictionHorizonMs: 6000 },
    { ...tracked, trackId: -1 },
    { ...tracked, trackId: 0.5 },
  ]) assert.equal(validPersonPreview(invalid), false)
})

test('relay accepts the native trajectory payload alongside glass and stair masks', () => {
  const value = preview(224)
  value.masks.push(preview(384, 'stairs').masks[0])
  value.people = [{ ...tracked }]
  assert.equal(validModelPreview(value), true)
  value.people[0].predictionHorizonMs = 6000
  assert.equal(validModelPreview(value), false)
})

test('native world-space tracker handles motion, reordered detections, gaps and resets', t => {
  const source = readFileSync(new URL('../modules/navigation-depth/ios/HazardModels.swift', import.meta.url), 'utf8')
  const marker = source.indexOf('final class PersonTrajectory {')
  assert.ok(marker >= 0, 'tracker must be included in a tracked Swift source file')
  if (process.platform !== 'darwin' || spawnSync('swiftc', ['--version']).status !== 0) {
    t.skip('Requires the Swift compiler on Mac; the iPhone build must also be verified')
    return
  }
  const directory = mkdtempSync(join(tmpdir(), 'lantern-tracker-'))
  try {
    const path = join(directory, 'Check.swift')
    const executable = join(directory, 'check')
    writeFileSync(path, `import Foundation
import simd
${source.slice(marker)}
@main enum Check {
  static func main() {
    let tracker = PersonTrajectory()
    let first = tracker.update([SIMD3<Float>(0, 0, 2)], time: 1, session: 1)[0]!
    precondition(first.future.isEmpty)
    let moving = tracker.update([SIMD3<Float>(0.65, 0, 2)], time: 1.65, session: 1)[0]!
    precondition(moving.id == first.id && abs(moving.future.last!.x - 1.25) < 0.001)
    let delayed = tracker.update([SIMD3<Float>(2.25, 0, 2)], time: 3.25, session: 1)[0]!
    precondition(delayed.id == first.id, "Use the full time between slow model frames")
    precondition(tracker.update([], time: 3.5, session: 1).isEmpty)
    let recovered = tracker.update([SIMD3<Float>(2.9, 0, 2)], time: 3.9, session: 1)[0]!
    precondition(recovered.id == first.id)
    let reset = tracker.update([SIMD3<Float>(2.9, 0, 2)], time: 4.55, session: 2)[0]!
    precondition(reset.id != first.id && reset.future.isEmpty)
    let stale = tracker.update([SIMD3<Float>(2.9, 0, 2)], time: 8, session: 2)[0]!
    precondition(stale.id != reset.id && stale.future.isEmpty)
    let multiple = PersonTrajectory()
    let initial = multiple.update([SIMD3<Float>(-1, 0, 2), SIMD3<Float>(1, 0, 2)], time: 1, session: 1)
    let reordered = multiple.update([SIMD3<Float>(1.1, 0, 2), SIMD3<Float>(-0.9, 0, 2)], time: 1.65, session: 1)
    precondition(reordered[0]!.id == initial[1]!.id && reordered[1]!.id == initial[0]!.id)
    let stationary = PersonTrajectory()
    _ = stationary.update([SIMD3<Float>(0, 0, 2)], time: 1, session: 1)
    let same = stationary.update([SIMD3<Float>(0, 0, 2)], time: 1.65, session: 1)[0]!
    precondition(simd_length(same.velocity) == 0)
  }
}`)
    const build = spawnSync('swiftc', ['-parse-as-library', path, '-o', executable], { encoding: 'utf8' })
    assert.equal(build.status, 0, build.stderr)
    const run = spawnSync(executable, [], { encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
