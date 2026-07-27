// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'
import { create } from './utils.js'

// Tests for tracking of unresolved forks as the head of a document moves

test('editing the winning head keeps unresolved forks', (t) => {
  const { indexer, api, cleanup } = create()
  t.after(cleanup)

  const updatedAt = new Date().toISOString()
  indexer.batch([
    { docId: 'A', versionId: '1', links: [], updatedAt },
    { docId: 'A', versionId: '2', links: ['1'], updatedAt },
    { docId: 'A', versionId: '3', links: ['1'], updatedAt },
  ])
  assert.deepEqual(
    api.getDoc('A')?.forks,
    ['2'],
    'Test setup: head is 3 with fork 2'
  )

  // A normal edit of the winning head: 2 is still an unresolved fork
  indexer.batch([{ docId: 'A', versionId: '4', links: ['3'], updatedAt }])
  assert.deepEqual(api.getDoc('A'), {
    docId: 'A',
    versionId: '4',
    links: ['3'],
    forks: ['2'],
    updatedAt,
  })

  // Another edit: fork is carried forward again
  indexer.batch([{ docId: 'A', versionId: '5', links: ['4'], updatedAt }])
  assert.deepEqual(api.getDoc('A')?.forks, ['2'])
})

test('a merge document resolves carried-forward forks', (t) => {
  const { indexer, api, cleanup } = create()
  t.after(cleanup)

  const updatedAt = new Date().toISOString()
  indexer.batch([
    { docId: 'A', versionId: '1', links: [], updatedAt },
    { docId: 'A', versionId: '2', links: ['1'], updatedAt },
    { docId: 'A', versionId: '3', links: ['1'], updatedAt },
  ])
  indexer.batch([{ docId: 'A', versionId: '4', links: ['3'], updatedAt }])
  assert.deepEqual(
    api.getDoc('A')?.forks,
    ['2'],
    'Test setup: head is 4 with fork 2'
  )

  // A merge document linking both the head and the fork resolves the fork
  indexer.batch([{ docId: 'A', versionId: '5', links: ['4', '2'], updatedAt }])
  assert.deepEqual(api.getDoc('A'), {
    docId: 'A',
    versionId: '5',
    links: ['4', '2'],
    forks: [],
    updatedAt,
  })
})

test('editing the losing fork keeps head, tracks new fork version', (t) => {
  const { indexer, api, cleanup } = create()
  t.after(cleanup)

  // updatedAt timestamps make version 3 the winner
  const t1 = new Date(2024, 0, 1).toISOString()
  const t2 = new Date(2024, 0, 2).toISOString()
  const t3 = new Date(2024, 0, 3).toISOString()
  indexer.batch([
    { docId: 'A', versionId: '1', links: [], updatedAt: t1 },
    { docId: 'A', versionId: '2', links: ['1'], updatedAt: t2 },
    { docId: 'A', versionId: '3', links: ['1'], updatedAt: t3 },
  ])
  assert.deepEqual(
    api.getDoc('A')?.forks,
    ['2'],
    'Test setup: head is 3 with fork 2'
  )

  // An edit of the fork 2, with an older timestamp than the head, so the
  // head wins again: 2 is no longer a head, but its edit 4 is
  indexer.batch([{ docId: 'A', versionId: '4', links: ['2'], updatedAt: t2 }])
  const head = api.getDoc('A')
  assert.equal(head?.versionId, '3')
  assert.deepEqual(head?.forks.sort(), ['4'])
})

test('fork is pruned when a doc linking it arrives in a later batch', (t) => {
  const { indexer, api, cleanup } = create()
  t.after(cleanup)

  const updatedAt = new Date().toISOString()
  indexer.batch([
    { docId: 'A', versionId: '1', links: [], updatedAt },
    { docId: 'A', versionId: '2', links: ['1'], updatedAt },
    { docId: 'A', versionId: '3', links: ['1'], updatedAt },
  ])
  assert.deepEqual(
    api.getDoc('A')?.forks,
    ['2'],
    'Test setup: head is 3 with fork 2'
  )

  // 4 links the fork 2 but is itself already linked by 5, which links the
  // head 3, so the head just moves to 5 and the fork branch is resolved
  indexer.batch([
    { docId: 'A', versionId: '5', links: ['3', '4'], updatedAt },
    { docId: 'A', versionId: '4', links: ['2'], updatedAt },
  ])
  assert.deepEqual(api.getDoc('A'), {
    docId: 'A',
    versionId: '5',
    links: ['3', '4'],
    forks: [],
    updatedAt,
  })
})

test('forks are tracked independently per docId', (t) => {
  const { indexer, api, cleanup } = create()
  t.after(cleanup)

  const updatedAt = new Date().toISOString()
  indexer.batch([
    { docId: 'A', versionId: 'a1', links: [], updatedAt },
    { docId: 'A', versionId: 'a2', links: ['a1'], updatedAt },
    { docId: 'A', versionId: 'a3', links: ['a1'], updatedAt },
    { docId: 'B', versionId: 'b1', links: [], updatedAt },
    { docId: 'B', versionId: 'b2', links: ['b1'], updatedAt },
  ])

  assert.deepEqual(api.getDoc('A')?.forks, ['a2'])
  assert.deepEqual(api.getDoc('B')?.forks, [])
})
