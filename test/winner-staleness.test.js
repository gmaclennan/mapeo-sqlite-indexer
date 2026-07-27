// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'
import { create } from './utils.js'

// KNOWN LIMITATIONS (pre-existing design constraint), documented as `todo`
// tests that assert the *correct* behaviour and currently fail.
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
// its parent's. Fixing them in general requires storing enough data to
// re-run getWinner against forks (e.g. storing fork docs, not just their
// versionIds), which is a schema/design change.

const t1 = '2024-01-01T00:00:01.000Z'
const t2 = '2024-01-01T00:00:02.000Z'
const t3 = '2024-01-01T00:00:03.000Z'

test(
  'head that becomes linked is replaced by the remaining unlinked fork',
  { todo: true },
  (t) => {
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
    // Currently returns head A (which is linked!) with forks ['C']
    assert.equal(head?.versionId, 'C')
    assert.deepEqual(head?.forks, [])
  }
)

test(
  'indexed state is the same whichever order a fork and an edit arrive',
  { todo: true },
  (t) => {
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

    // Currently head1 is Y with forks ['F'] but head2 is F with forks ['Y']
    assert.deepEqual(head1, head2)
  }
)
