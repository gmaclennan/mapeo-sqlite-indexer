// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'
import { create, permute } from './utils.js'

// The result of indexing must not depend on how the documents are grouped
// into batches: real usage indexes documents incrementally as they arrive,
// so any prefix of the history may already be persisted before the rest
// arrives. These tests replay every arrival order of a version DAG, split
// across separate batch() calls at every possible point, and after each
// document when batches arrive one-by-one.

const docs = [
  { docId: 'A', versionId: '1', links: [], updatedAt: '' },
  { docId: 'A', versionId: '2', links: ['1'], updatedAt: '' },
  { docId: 'A', versionId: '3', links: ['1'], updatedAt: '' },
  { docId: 'A', versionId: '4', links: ['2', '3'], updatedAt: '' },
  { docId: 'A', versionId: '5', links: ['4'], updatedAt: '' },
]

const expected = {
  docId: 'A',
  versionId: '5',
  links: ['4'],
  forks: [],
  updatedAt: '',
}

test('Expected head for all permutations split across two batches', (t) => {
  const { indexer, api, cleanup, clear } = create()
  t.after(cleanup)

  for (const permutation of permute(docs.slice())) {
    for (let split = 1; split < permutation.length; split++) {
      indexer.batch(permutation.slice(0, split))
      indexer.batch(permutation.slice(split))
      const head = api.getDoc(expected.docId)
      assert.deepEqual(
        { ...head, forks: head?.forks.sort() },
        expected,
        `order ${JSON.stringify(
          permutation.map((doc) => doc.versionId)
        )} split at ${split}`
      )
      clear()
    }
  }
})

test('Expected head for all permutations indexed one doc at a time', (t) => {
  const { indexer, api, cleanup, clear } = create()
  t.after(cleanup)

  for (const permutation of permute(docs.slice())) {
    for (const doc of permutation) {
      indexer.batch([doc])
    }
    const head = api.getDoc(expected.docId)
    assert.deepEqual(
      { ...head, forks: head?.forks.sort() },
      expected,
      JSON.stringify(permutation.map((doc) => doc.versionId))
    )
    clear()
  }
})

test('An empty batch is a no-op', (t) => {
  const { indexer, api, cleanup } = create()
  t.after(cleanup)

  indexer.batch([])
  const updatedAt = new Date().toISOString()
  indexer.batch([{ docId: 'A', versionId: '1', links: [], updatedAt }])
  indexer.batch([])

  assert.deepEqual(api.getDoc('A'), {
    docId: 'A',
    versionId: '1',
    links: [],
    forks: [],
    updatedAt,
  })
})
