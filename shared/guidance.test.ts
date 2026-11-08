import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLoop, reflex, selectHeading } from './guidance.ts'
import { createMock, emptyObservation } from './mock.ts'

test('reflex overrides guidance even with a model hazard in the same frame', () => {
  const mock = createMock()
  let glassAhead = false
  const loop = createLoop({ ...mock.providers, lidar: () => ({ ...mock.providers.lidar(),
    hazards: [{ kind: 'glass', confidence: 0.9, bearing: glassAhead ? [-5, 5] : [80, 90] }] }) })
  assert.equal(loop.tick().command.cue, 'direction')
  glassAhead = true
  mock.setScenario('obstacle')
  const warning = loop.tick()
  assert.equal(warning.heading, null)
  assert.equal(warning.modelWarning, undefined)
  assert.deepEqual(mock.lastCommand(), { cue: 'obstacle', motors: [1, 1, 1, 1, 1] })
  mock.setScenario('dropout')
  glassAhead = false
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
  assert.equal(selectHeading(emptyObservation(), providers.navigation(), null), null)
  assert.equal(selectHeading(providers.lidar(), { ...providers.navigation(), desiredHeading: 180 }, null), null)
})

test('stairs block forward and a predicted pedestrian crossing blocks forward before arrival', () => {
  const mock = createMock()
  const loop = createLoop({ ...mock.providers, navigation: () => ({ ...mock.providers.navigation(), desiredHeading: 0 }) })
  for (const scenario of ['stairs', 'person'] as const) {
    mock.setScenario(scenario)
    const frame = loop.tick()
    assert.equal(frame.baselineHeading, 0)
    assert.ok(frame.blockedHeadings?.includes(0))
    assert.notEqual(frame.heading, 0)
    assert.equal(frame.reflex, 'clear')
    assert.equal(frame.command.cue, 'obstacle')
    assert.equal(frame.modelWarning, scenario)
  }
})

test('unlocated glass warns and suppresses overlapping direction cues independently of the depth reflex', () => {
  const mock = createMock()
  mock.setScenario('glass')
  const frame = createLoop(mock.providers).tick()
  assert.equal(frame.blockedHeadings?.length, 9)
  assert.equal(frame.heading, null)
  assert.equal(frame.command.cue, 'obstacle')
  assert.equal(frame.modelWarning, 'glass')
  assert.equal(frame.reflex, 'clear')
})

test('a fresh native glass bearing warns with unknown depth and no route, but expires with the observation', () => {
  const { providers } = createMock()
  const now = 1000
  const loop = createLoop({
    ...providers,
    lidar: () => ({ ...emptyObservation(), source: 'arkit', timeMs: now,
      hazards: [{ kind: 'glass', confidence: 0.9, bearing: [-5, 5] }] }),
    navigation: () => ({ ...providers.navigation(), status: 'idle', desiredHeading: null }),
  })
  const fresh = loop.tick(now + 10)
  assert.equal(fresh.reflex, 'unknown')
  assert.equal(fresh.command.cue, 'obstacle')
  assert.equal(fresh.modelWarning, 'glass')
  assert.equal(fresh.reflexDispatchMs, undefined)
  assert.equal(loop.tick(now + 601).command.cue, 'unavailable')
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

test('native direction requires enabled guidance and observed corridor cells, even without a belt', () => {
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
  mock.setConnected(false)
  const offline = { ...native, belt: { ...native.belt, send: () => assert.fail('Sent a command to a disconnected belt') } }
  assert.equal(createLoop(offline, true).tick().heading, 0)
})
