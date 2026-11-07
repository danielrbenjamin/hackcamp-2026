import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chooseSiriPlace } from './placeMatch.ts'

const campus = { name: 'UBC Bookstore', label: 'UBC Bookstore, University Boulevard' }
const north = { name: 'Café North', label: 'Café North, 12 Main Street' }
const south = { name: 'Café North', label: 'Café North, 56 Oak Street' }

test('auto-start accepts a unique normalized place name or full address', () => {
  assert.equal(chooseSiriPlace('ubc bookstore', [campus, north]), campus)
  assert.equal(chooseSiriPlace('Cafe North 12 Main Street', [north, south]), north)
})

test('auto-start leaves ambiguous, partial, and empty matches for selection', () => {
  assert.equal(chooseSiriPlace('Cafe North', [north, south]), null)
  assert.equal(chooseSiriPlace('bookstore', [campus]), null)
  assert.equal(chooseSiriPlace('missing', []), null)
})
