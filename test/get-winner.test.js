// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'
import { create } from './utils.js'
import SqliteIndexer, { defaultGetWinner } from '../index.js'

test('defaultGetWinner picks the doc with the later updatedAt', () => {
  const older = { docId: 'A', versionId: '2', links: [], updatedAt: '2024-01' }
  const newer = { docId: 'A', versionId: '1', links: [], updatedAt: '2024-02' }
  assert.equal(defaultGetWinner(older, newer), newer)
  assert.equal(defaultGetWinner(newer, older), newer)
})

test('defaultGetWinner breaks updatedAt ties with the higher versionId', () => {
  const updatedAt = '2024-01'
  const v1 = { docId: 'A', versionId: '1', links: [], updatedAt }
  const v2 = { docId: 'A', versionId: '2', links: [], updatedAt }
  assert.equal(defaultGetWinner(v1, v2), v2)
  assert.equal(defaultGetWinner(v2, v1), v2)
})

test('custom getWinner option is used to select the head', (t) => {
  const { db, api, cleanup } = create()
  t.after(cleanup)

  // A getWinner that prefers the OLDEST version (opposite of the default)
  const indexer = new SqliteIndexer(db, {
    docTableName: 'docs',
    backlinkTableName: 'backlinks',
    getWinner: (docA, docB) => {
      if (docA.updatedAt < docB.updatedAt) return docA
      if (docB.updatedAt < docA.updatedAt) return docB
      return docA.versionId < docB.versionId ? docA : docB
    },
  })

  const older = new Date(2024, 0, 1).toISOString()
  const newer = new Date(2024, 0, 2).toISOString()
  indexer.batch([
    { docId: 'A', versionId: '1', links: [], updatedAt: older },
    { docId: 'A', versionId: '2', links: ['1'], updatedAt: newer },
    { docId: 'A', versionId: '3', links: ['1'], updatedAt: older },
  ])

  // Versions 2 and 3 fork from 1. The default getWinner would pick 2
  // (newer updatedAt); the custom one picks 3 (older updatedAt)
  const head = api.getDoc('A')
  assert.equal(head?.versionId, '3')
  assert.deepEqual(head?.forks, ['2'])
})
