// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'
import { create } from './utils.js'

// Regression tests for two former design limitations (see
// FORK-TRACKING-PLAN.md): because forks were stored as bare versionIds,
// getWinner could never be re-run against a fork or promote it to head.
// The candidate table (which stores the full document of every unlinked
// version) fixes both: the head is always the getWinner-maximum of all
// current candidates, whatever order documents arrive in — including when
// device clocks are skewed or updatedAt values tie.

const t1 = '2024-01-01T00:00:01.000Z'
const t2 = '2024-01-01T00:00:02.000Z'
const t3 = '2024-01-01T00:00:03.000Z'

test('head that becomes linked is replaced by the remaining fork', (t) => {
  const { indexer, api, cleanup } = create()
  t.after(cleanup)

  // A(root, t2) ← B(links A, t3) ← C(links B, t1): C was written on a
  // device with a slow clock, so its updatedAt is older than A's.
  indexer.batch([{ docId: 'X', versionId: 'A', links: [], updatedAt: t2 }])
  // C arrives before its parent B: getWinner(A, C) picks A (t2 > t1),
  // so C becomes a fork of head A
  indexer.batch([{ docId: 'X', versionId: 'C', links: ['B'], updatedAt: t1 }])
  // B arrives: it is already linked (by C), and it links A. A is now
  // linked too, so the only unlinked version — the true head — is C.
  indexer.batch([{ docId: 'X', versionId: 'B', links: ['A'], updatedAt: t3 }])

  assert.deepEqual(api.getDoc('X'), {
    docId: 'X',
    versionId: 'C',
    links: ['B'],
    forks: [],
    updatedAt: t1,
  })
})

test('same result whichever order a fork and an edit arrive', (t) => {
  const { indexer, api, cleanup, clear } = create()
  t.after(cleanup)

  // A(root, t1); B(links A, t3); F(links A, t2) — a fork that loses to
  // B; Y(links B, t1) — an edit of B from a device with a slow clock,
  // so getWinner(F, Y) picks F.
  const A = { docId: 'X', versionId: 'A', links: [], updatedAt: t1 }
  const B = { docId: 'X', versionId: 'B', links: ['A'], updatedAt: t3 }
  const F = { docId: 'X', versionId: 'F', links: ['A'], updatedAt: t2 }
  const Y = { docId: 'X', versionId: 'Y', links: ['B'], updatedAt: t1 }

  const expected = {
    docId: 'X',
    versionId: 'F',
    links: ['A'],
    forks: ['Y'],
    updatedAt: t2,
  }

  // Order 1: F becomes a fork of head B, then Y replaces the linked B.
  // F must still compete with Y for the head.
  for (const doc of [A, B, F, Y]) indexer.batch([doc])
  assert.deepEqual(api.getDoc('X'), expected)

  clear()

  // Order 2: Y replaces the linked B first, then F arrives and competes
  for (const doc of [A, B, Y, F]) indexer.batch([doc])
  assert.deepEqual(api.getDoc('X'), expected)
})
