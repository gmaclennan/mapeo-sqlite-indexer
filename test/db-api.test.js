// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'
import { create } from './utils.js'

test('DbApi.getBacklink returns backlink row if it exists', (t) => {
  const { indexer, api, cleanup } = create()
  t.after(cleanup)

  const updatedAt = new Date().toISOString()
  indexer.batch([
    { docId: 'A', versionId: '1', links: [], updatedAt },
    { docId: 'A', versionId: '2', links: ['1'], updatedAt },
  ])

  assert.deepEqual(api.getBacklink('1'), { versionId: '1' })
  assert.equal(api.getBacklink('2'), undefined)
})

test('DbApi.writeDoc without forks argument uses doc.forks', (t) => {
  const { api, cleanup } = create()
  t.after(cleanup)

  const updatedAt = new Date().toISOString()
  api.writeDoc({
    docId: 'A',
    versionId: '1',
    links: [],
    forks: ['2'],
    updatedAt,
  })

  assert.deepEqual(api.getDoc('A'), {
    docId: 'A',
    versionId: '1',
    links: [],
    forks: ['2'],
    updatedAt,
  })
})
