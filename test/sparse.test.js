// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'
import { create } from './utils.js'

// During sync a device may receive only part of a document's history:
// documents can link to parent versions that have not arrived (and may
// never arrive). Indexing must work with these dangling links.

test('doc linking a version that never arrives is indexed as head', (t) => {
  const { indexer, api, cleanup } = create()
  t.after(cleanup)

  const updatedAt = new Date().toISOString()
  indexer.batch([{ docId: 'A', versionId: '2', links: ['1'], updatedAt }])

  assert.deepEqual(api.getDoc('A'), {
    docId: 'A',
    versionId: '2',
    links: ['1'],
    forks: [],
    updatedAt,
  })
})

test('parent arriving after its child is ignored (already linked)', (t) => {
  const { indexer, api, cleanup } = create()
  t.after(cleanup)

  const updatedAt = new Date().toISOString()
  indexer.batch([{ docId: 'A', versionId: '2', links: ['1'], updatedAt }])
  indexer.batch([{ docId: 'A', versionId: '1', links: [], updatedAt }])

  assert.deepEqual(api.getDoc('A'), {
    docId: 'A',
    versionId: '2',
    links: ['1'],
    forks: [],
    updatedAt,
  })
})

test('history arriving newest-first one batch at a time', (t) => {
  const { indexer, api, cleanup } = create()
  t.after(cleanup)

  const updatedAt = new Date().toISOString()
  indexer.batch([{ docId: 'A', versionId: '3', links: ['2'], updatedAt }])
  indexer.batch([{ docId: 'A', versionId: '2', links: ['1'], updatedAt }])
  indexer.batch([{ docId: 'A', versionId: '1', links: [], updatedAt }])

  assert.deepEqual(api.getDoc('A'), {
    docId: 'A',
    versionId: '3',
    links: ['2'],
    forks: [],
    updatedAt,
  })
})

test('a doc that links itself leaves the existing head in place', (t) => {
  const { indexer, api, cleanup } = create()
  t.after(cleanup)

  const updatedAt = new Date().toISOString()
  indexer.batch([{ docId: 'A', versionId: '1', links: [], updatedAt }])
  // Degenerate input: a doc that links its own versionId (and the head).
  // It removes the head from the candidates but is itself linked, so no
  // valid head candidate is known: the existing head is left in place.
  indexer.batch([{ docId: 'A', versionId: '2', links: ['2', '1'], updatedAt }])

  assert.deepEqual(api.getDoc('A'), {
    docId: 'A',
    versionId: '1',
    links: [],
    forks: [],
    updatedAt,
  })
})

test('two sides of a fork syncing without their common ancestor', (t) => {
  const { indexer, api, cleanup } = create()
  t.after(cleanup)

  const updatedAt = new Date().toISOString()
  // Both 2 and 3 fork from 1, which never arrives
  indexer.batch([{ docId: 'A', versionId: '2', links: ['1'], updatedAt }])
  indexer.batch([{ docId: 'A', versionId: '3', links: ['1'], updatedAt }])

  const head = api.getDoc('A')
  assert.equal(head?.versionId, '3')
  assert.deepEqual(head?.forks, ['2'])
})
