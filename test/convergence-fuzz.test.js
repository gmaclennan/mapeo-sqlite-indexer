// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'
import { create } from './utils.js'

// Property-based test: for randomly generated version DAGs (edits, forks,
// merges, missing ancestors), indexing must:
//
//   1. Converge: any delivery order and any batching produces the same
//      final indexed state
//   2. Maintain invariants: the head and all forks are unlinked versions,
//      forks contain no duplicates and never the head itself, and
//      {head} ∪ forks equals exactly the set of delivered-but-unlinked
//      versions of the document
//
// Timestamps here are monotonic (every edit is newer than its parent, as
// when device clocks are well behaved). With clock skew or identical
// updatedAt values across a fork, the current design is NOT fully
// order-independent — see the known-limitation tests in
// winner-staleness.test.js.

/** Deterministic pseudo-random number generator (mulberry32) */
function makeRandom(seed) {
  let a = seed >>> 0
  return function random() {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * @template T
 * @param {() => number} rnd
 * @param {T[]} arr
 * @returns {T}
 */
const pick = (rnd, arr) => arr[(rnd() * arr.length) | 0]

/**
 * @param {() => number} rnd
 * @param {import('../index.js').IndexableDocument[]} arr
 */
function shuffle(rnd, arr) {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/**
 * Generate a random version history for 1-3 docIds, with monotonically
 * increasing timestamps, then drop ~10% of docs (never-synced versions).
 * @param {() => number} rnd
 * @returns {import('../index.js').IndexableDocument[]}
 */
function generateDocs(rnd) {
  /** @type {import('../index.js').IndexableDocument[]} */
  const docs = []
  let vCounter = 0
  let clock = Date.parse('2024-01-01T00:00:00.000Z')
  const nDocs = 1 + ((rnd() * 3) | 0)
  for (let d = 0; d < nDocs; d++) {
    const docId = `doc${d}`
    // Random ids so lexical order differs from causal order, like real
    // Mapeo version ids
    const newVersion = () =>
      `${((rnd() * 0xffff) | 0).toString(16).padStart(4, '0')}-${vCounter++}`
    const ts = () => new Date((clock += 1000)).toISOString()
    /** @type {string[]} */
    let heads = []
    const root = { docId, versionId: newVersion(), links: [], updatedAt: ts() }
    docs.push(root)
    heads.push(root.versionId)
    const nOps = 1 + ((rnd() * 6) | 0)
    for (let op = 0; op < nOps; op++) {
      const kind = pick(rnd, ['edit', 'edit', 'edit', 'fork', 'merge'])
      if (kind === 'merge' && heads.length >= 2) {
        const a = pick(rnd, heads)
        const b = pick(rnd, heads)
        if (a === b) continue
        const v = {
          docId,
          versionId: newVersion(),
          links: [a, b],
          updatedAt: ts(),
        }
        docs.push(v)
        heads = heads.filter((h) => h !== a && h !== b)
        heads.push(v.versionId)
      } else if (kind === 'fork') {
        const parent = pick(rnd, heads)
        const v1 = {
          docId,
          versionId: newVersion(),
          links: [parent],
          updatedAt: ts(),
        }
        const v2 = {
          docId,
          versionId: newVersion(),
          links: [parent],
          updatedAt: ts(),
        }
        docs.push(v1, v2)
        heads = heads.filter((h) => h !== parent)
        heads.push(v1.versionId, v2.versionId)
      } else {
        const parent = pick(rnd, heads)
        const v = {
          docId,
          versionId: newVersion(),
          links: [parent],
          updatedAt: ts(),
        }
        docs.push(v)
        heads = heads.filter((h) => h !== parent)
        heads.push(v.versionId)
      }
    }
  }
  // Drop some docs entirely: versions that never sync to this device
  let delivered = docs.filter(() => rnd() > 0.1)
  if (delivered.length === 0) delivered = [docs[0]]
  // Sometimes re-deliver a doc (e.g. duplicate delivery during sync)
  if (rnd() < 0.3) delivered.push(pick(rnd, delivered))
  return delivered
}

/**
 * @param {import('../index.js').IndexableDocument[]} delivered
 * @param {any[]} state - rows of the docs table
 * @returns {string[]} invariant violations
 */
function checkInvariants(delivered, state) {
  const problems = []
  const linked = new Set()
  for (const d of delivered) for (const l of d.links) linked.add(l)
  /** @type {Map<string, Set<string>>} */
  const versionsByDocId = new Map()
  for (const d of delivered) {
    let versions = versionsByDocId.get(d.docId)
    if (!versions) versionsByDocId.set(d.docId, (versions = new Set()))
    versions.add(d.versionId)
  }
  for (const row of state) {
    const versions = versionsByDocId.get(row.docId) ?? new Set()
    const unlinked = [...versions].filter((v) => !linked.has(v)).sort()
    if (linked.has(row.versionId)) {
      problems.push(`head ${row.versionId} of ${row.docId} is linked`)
    }
    if (new Set(row.forks).size !== row.forks.length) {
      problems.push(`duplicate forks for ${row.docId}: ${row.forks}`)
    }
    if (row.forks.includes(row.versionId)) {
      problems.push(`head ${row.versionId} of ${row.docId} is in its own forks`)
    }
    const headSet = [row.versionId, ...row.forks].sort()
    if (JSON.stringify(headSet) !== JSON.stringify(unlinked)) {
      problems.push(
        `${row.docId}: {head}∪forks ${JSON.stringify(headSet)} != ` +
          `unlinked versions ${JSON.stringify(unlinked)}`,
      )
    }
  }
  return problems
}

test('random DAGs converge for all orders/batchings, invariants hold', (t) => {
  const { indexer, db, cleanup, clear } = create()
  t.after(cleanup)
  const readState = db.prepare('SELECT * FROM docs ORDER BY docId')

  const CASES = 60
  const ORDERS = 4
  for (let c = 0; c < CASES; c++) {
    const rnd = makeRandom(1 + c * 7919)
    const delivered = generateDocs(rnd)
    /** @type {string | undefined} */
    let firstState
    for (let o = 0; o < ORDERS; o++) {
      const order = o === 0 ? delivered : shuffle(rnd, delivered)
      let i = 0
      while (i < order.length) {
        const size = 1 + ((rnd() * 5) | 0)
        indexer.batch(order.slice(i, i + size))
        i += size
      }
      const state = readState.all().map((r) => ({
        docId: r.docId,
        versionId: r.versionId,
        forks: JSON.parse(/** @type {any} */ (r).forks).sort(),
        updatedAt: r.updatedAt,
      }))
      const problems = checkInvariants(delivered, state)
      assert.deepEqual(problems, [], `case ${c} order ${o}: invariants`)
      const stateJson = JSON.stringify(state)
      if (o === 0) {
        firstState = stateJson
      } else {
        assert.equal(
          stateJson,
          firstState,
          `case ${c} order ${o}: same state for all delivery orders`,
        )
      }
      clear()
    }
  }
})
