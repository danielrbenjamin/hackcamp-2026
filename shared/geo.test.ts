import assert from 'node:assert/strict'
import { test } from 'node:test'
import { relativeHeading, routeBearing } from './geo.ts'

test('route bearing follows the ordered segment around a corner', () => {
  const path = [{ lat: 0, lng: 0 }, { lat: 0, lng: 0.001 }, { lat: 0.001, lng: 0.001 }]
  assert.equal(routeBearing({ lat: 0, lng: 0.0005 }, path), 90)
  assert.equal(routeBearing({ lat: 0, lng: 0.001 }, path), 0)
  assert.equal(routeBearing({ lat: 0.01, lng: 0.01 }, path), null)
  assert.equal(relativeHeading(path[0], path[1], 180), -90)
})
