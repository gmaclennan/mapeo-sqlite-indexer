// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'
import { create } from './utils.js'

// Documents can be re-indexed, e.g. if the same data is re-synced from
// another peer, or if the index is rebuilt from partially-indexed logs.
// Re-indexing a version that is already indexed should be a no-op.

test('re-indexing the current head version is a no-op', (t) => {
  const { indexer, api, cleanup } = create()
  t.after(cleanup)

  const updatedAt = new Date().toISOString()
  const doc = { docId: 'A', versionId: '1', links: [], updatedAt }
  indexer.batch([doc])
  const before = api.getDoc('A')
  indexer.batch([doc])

  assert.deepEqual(api.getDoc('A'), before)
  assert.deepEqual(api.getDoc('A')?.forks, [])
})

test('re-indexing a version that is a losing fork is a no-op', (t) => {
  const { indexer, api, cleanup } = create()
  t.after(cleanup)

  const updatedAt = new Date().toISOString()
  indexer.batch([
    { docId: 'A', versionId: '1', links: [], updatedAt },
    { docId: 'A', versionId: '2', links: ['1'], updatedAt },
    { docId: 'A', versionId: '3', links: ['1'], updatedAt },
  ])
  const before = api.getDoc('A')
  assert.deepEqual(before?.forks, ['2'], 'Test setup: 2 is a fork')

  indexer.batch([{ docId: 'A', versionId: '2', links: ['1'], updatedAt }])

  assert.deepEqual(api.getDoc('A'), before)
})

test('duplicate docs within a single batch are indexed once', (t) => {
  const { indexer, api, cleanup } = create()
  t.after(cleanup)

  const updatedAt = new Date().toISOString()
  const doc = { docId: 'A', versionId: '1', links: [], updatedAt }
  indexer.batch([doc, doc, { ...doc }])

  assert.deepEqual(api.getDoc('A'), {
    docId: 'A',
    versionId: '1',
    links: [],
    forks: [],
    updatedAt,
  })
})

test('re-indexing a complete history is a no-op', (t) => {
  const { indexer, api, cleanup } = create()
  t.after(cleanup)

  const updatedAt = new Date().toISOString()
  const docs = [
    { docId: 'A', versionId: '1', links: [], updatedAt },
    { docId: 'A', versionId: '2', links: ['1'], updatedAt },
    { docId: 'A', versionId: '3', links: ['1'], updatedAt },
    { docId: 'A', versionId: '4', links: ['2', '3'], updatedAt },
    { docId: 'B', versionId: '5', links: [], updatedAt },
  ]
  indexer.batch(docs)
  const beforeA = api.getDoc('A')
  const beforeB = api.getDoc('B')

  indexer.batch(docs)

  assert.deepEqual(api.getDoc('A'), beforeA)
  assert.deepEqual(api.getDoc('B'), beforeB)
})

test('re-indexing after deleteAll() rebuilds the same index', (t) => {
  const { indexer, api, cleanup } = create()
  t.after(cleanup)

  const updatedAt = new Date().toISOString()
  const docs = [
    { docId: 'A', versionId: '1', links: [], updatedAt },
    { docId: 'A', versionId: '2', links: ['1'], updatedAt },
    { docId: 'A', versionId: '3', links: ['1'], updatedAt },
  ]
  indexer.batch(docs)
  const before = api.getDoc('A')

  indexer.deleteAll()
  assert.equal(api.getDoc('A'), undefined)

  indexer.batch(docs)
  assert.deepEqual(api.getDoc('A'), before)
})
