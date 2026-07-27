// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'
import { create } from './utils.js'

// KNOWN LIMITATIONS (pre-existing design constraint). These tests pin the
// CURRENT behaviour, which is wrong — see FORK-TRACKING-PLAN.md for the
// correct behaviour and the plan to fix it. When the fix lands these
// assertions must be flipped to the expected values noted inline.
//
// Forks are stored as bare versionIds, so the indexer can never re-run
// getWinner against a fork, or promote a fork to head, after the fact.
// This matters whenever getWinner's choice disagrees with causal order —
// i.e. when a causally-older branch has a newer updatedAt (device clock
// skew) or when updatedAt values are equal across a fork (the versionId
// tie-break is causally arbitrary for random ids). Consequences:
//
// 1. Stale head: a head that later becomes linked stays head, because the
//    true head (a fork) cannot be promoted (its full doc is not stored)
// 2. Divergence: different arrival orders can produce different heads,
//    because the replace path never compares the new doc against
//    inherited forks
//
// Property-based testing (see convergence-fuzz.test.js) shows both
// problems disappear entirely when every edit's updatedAt is newer than
// its parent's.

const t1 = '2024-01-01T00:00:01.000Z'
const t2 = '2024-01-01T00:00:02.000Z'
const t3 = '2024-01-01T00:00:03.000Z'

test('LIMITATION: head that becomes linked is not replaced', (t) => {
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

  const head = api.getDoc('X')
  // The CORRECT result would be head C with forks []. Currently the
  // superseded (linked) A stays head because C's document is not stored.
  assert.equal(head?.versionId, 'A')
  assert.deepEqual(head?.forks, ['C'])
})

test('LIMITATION: fork and edit arrival order changes the result', (t) => {
  const { indexer, api, cleanup, clear } = create()
  t.after(cleanup)

  // A(root, t1); B(links A, t3); F(links A, t2) — a fork that loses to
  // B; Y(links B, t1) — an edit of B from a device with a slow clock,
  // so getWinner(F, Y) would pick F.
  const A = { docId: 'X', versionId: 'A', links: [], updatedAt: t1 }
  const B = { docId: 'X', versionId: 'B', links: ['A'], updatedAt: t3 }
  const F = { docId: 'X', versionId: 'F', links: ['A'], updatedAt: t2 }
  const Y = { docId: 'X', versionId: 'Y', links: ['B'], updatedAt: t1 }

  // Order 1: F becomes a fork of head B, then Y replaces the linked B,
  // inheriting fork F without getWinner ever comparing Y with F
  for (const doc of [A, B, F, Y]) indexer.batch([doc])
  const head1 = api.getDoc('X')

  clear()

  // Order 2: Y replaces the linked B first, then F arrives and wins
  // getWinner(Y, F)
  for (const doc of [A, B, Y, F]) indexer.batch([doc])
  const head2 = api.getDoc('X')

  // The CORRECT result would be head1 equal to head2 (same head whatever
  // the arrival order). Currently they diverge:
  assert.equal(head1?.versionId, 'Y')
  assert.deepEqual(head1?.forks, ['F'])
  assert.equal(head2?.versionId, 'F')
  assert.deepEqual(head2?.forks, ['Y'])
})
