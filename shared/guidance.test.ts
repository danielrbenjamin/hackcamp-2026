import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLoop, reflex, selectHeading } from './guidance.ts'
import { createMock, emptyObservation } from './mock.ts'

test('reflex overrides guidance while inference is still pending', async () => {
  const mock = createMock()
  let inferenceStarted = false
  const loop = createLoop({ ...mock.providers, model: () => {
    inferenceStarted = true
    return new Promise(() => {})
  } })
  assert.equal(loop.tick().command.cue, 'direction')
  await Promise.resolve()
  assert.equal(inferenceStarted, true)
  mock.setScenario('obstacle')
  const warning = loop.tick()
  assert.equal(warning.heading, null)
  assert.deepEqual(mock.lastCommand(), { cue: 'obstacle', motors: [1, 1, 1, 1, 1] })
  mock.setScenario('dropout')
  assert.equal(loop.tick().command.cue, 'unavailable')
  assert.deepEqual(mock.lastCommand()?.motors, [0, 0, 0, 0, 0])
})

test('stale observations suppress direction cues', () => {
  const now = 1_000
  const observation = { ...createMock().providers.lidar(), timeMs: now }
  assert.equal(reflex(observation, now), 'clear')
  assert.equal(reflex(observation, now + 601), 'unknown')
})

test('close valid returns still warn when other zones are unknown', () => {
  const now = 1_000
  const observation = { ...emptyObservation(), timeMs: now, zones: [null, null, 0.4, null, null] as const }
  assert.equal(reflex(observation, now), 'obstacle')
})

test('heading selector rejects unknown clearance and motion outside the candidate envelope', () => {
  const { providers } = createMock()
  assert.equal(selectHeading(emptyObservation(), null, providers.navigation(), null), null)
  assert.equal(selectHeading(providers.lidar(), null, { ...providers.navigation(), desiredHeading: 180 }, null), null)
})

test('reconnection replays the current warning rather than the old direction', () => {
  const mock = createMock()
  const loop = createLoop(mock.providers)
  loop.tick()
  mock.setConnected(false)
  mock.setScenario('obstacle')
  loop.tick()
  assert.equal(mock.lastCommand()?.cue, 'direction')
  mock.setConnected(true)
  loop.tick()
  assert.equal(mock.lastCommand()?.cue, 'obstacle')
  loop.stop()
  assert.equal(mock.lastCommand()?.cue, 'idle')
})

test('physical belt refreshes a reflex command before the firmware timeout', () => {
  const mock = createMock()
  mock.setScenario('obstacle')
  const now = Date.now()
  let sends = 0
  const loop = createLoop({
    ...mock.providers,
    lidar: () => ({ ...mock.providers.lidar(), source: 'arkit', timeMs: now }),
    belt: {
      status: () => ({ connected: true, battery: null, source: 'ble' }),
      send: command => { assert.equal(command.cue, 'obstacle'); sends++ },
    },
  })
  assert.equal(loop.tick(now + 20).reflexDispatchMs, 20)
  loop.tick(now + 100)
  loop.tick(now + 220)
  assert.equal(sends, 2)
})

test('real direction requires explicit opt-in and observed corridor cells', () => {
  const mock = createMock()
  const { providers } = mock
  const route = { ...providers.navigation(), desiredHeading: 0, source: 'google' as const }
  const frame = { ...providers.lidar(), source: 'arkit' as const }
  const known = { ...frame, grid: { ...frame.grid, cells: frame.grid.cells.map(() => 1 as const) } }
  const native = { ...providers, lidar: () => known, navigation: () => route }
  assert.equal(createLoop(native).tick().heading, null)
  assert.equal(createLoop(native, true).tick().heading, 0)
  const unknown = { ...native, lidar: () => ({ ...known, grid: emptyObservation().grid }) }
  assert.equal(createLoop(unknown, true).tick().heading, null)
})
