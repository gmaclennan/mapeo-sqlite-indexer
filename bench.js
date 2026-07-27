// Benchmark for @mapeo/sqlite-indexer
//
// Models real-life Mapeo usage patterns as separate scenarios:
//
//   create  New documents (links: []) indexed in batches, e.g. initial data
//           creation on a single device.
//   edit    Edits to existing documents, each new version linking to the
//           current head version of the same document (linear history).
//   fork    Concurrent edits: two versions linking the same parent version
//           (as happens when two devices edit the same doc before syncing),
//           followed by "merge" versions that resolve the forks.
//   sync    Initial sync from other peers: a full history of creates, edits
//           and forks arrives in arbitrary order (shuffled), so documents
//           are often indexed before or after their parents.
//
// Documents use realistic ID sizes (32-byte hex docId and versionId, like
// Mapeo core). Doc generation happens before timing starts, generation is
// seeded so runs are reproducible and comparable across Node.js and
// better-sqlite3 versions.
//
// Usage:
//   node bench.js [scenario ...] [--docs N] [--batch N] [--repeat N] [--json]
//
//   scenario   One or more of: create, edit, fork, sync (default: all)
//   --docs N   Approximate number of docs indexed per scenario (default 50000)
//   --batch N  Batch size passed to indexer.batch() (default 100)
//   --repeat N Number of timed repetitions per scenario (default 3)
//   --json     Output machine-readable JSON instead of a table

import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { performance } from 'perf_hooks'

// Set INDEXER_IMPL to benchmark an alternative implementation (path
// relative to this file), e.g. INDEXER_IMPL=./index-experiment.js node bench.js
const { default: SqliteIndexer } = await import(
  process.env.INDEXER_IMPL ?? './index.js'
)

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

const HEX = '0123456789abcdef'

/** Generate a random hex ID of `bytes` bytes (like Mapeo's 32-byte IDs) */
function makeId(random, bytes = 32) {
  let id = ''
  for (let i = 0; i < bytes * 2; i++) {
    id += HEX[(random() * 16) | 0]
  }
  return id
}

function createDb() {
  const dir = mkdtempSync(path.join(tmpdir(), 'mapeo-sqlite-indexer-bench-'))
  const db = new Database(path.join(dir, 'db.sqlite'))
  db.pragma('journal_mode = WAL')
  db.prepare(
    `CREATE TABLE IF NOT EXISTS docs (
      docId TEXT PRIMARY KEY NOT NULL,
      versionId TEXT NOT NULL,
      links TEXT NOT NULL,
      forks TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    ) WITHOUT ROWID`,
  ).run()
  db.prepare(
    `CREATE TABLE IF NOT EXISTS backlinks
    (versionId TEXT PRIMARY KEY NOT NULL)
    WITHOUT ROWID`,
  ).run()
  const indexer = new SqliteIndexer(db, {
    docTableName: 'docs',
    backlinkTableName: 'backlinks',
  })
  return {
    db,
    indexer,
    cleanup() {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** Timestamps increase monotonically, like real edits over time */
function makeClock() {
  let t = Date.parse('2024-01-01T00:00:00.000Z')
  return () => new Date((t += 1000)).toISOString()
}

/**
 * Generate `count` brand-new documents (links: [])
 */
function generateCreates(random, clock, count) {
  const docs = new Array(count)
  for (let i = 0; i < count; i++) {
    docs[i] = {
      docId: makeId(random),
      versionId: makeId(random),
      links: [],
      updatedAt: clock(),
    }
  }
  return docs
}

/**
 * Generate edits of existing docs. `heads` maps docId -> head versionId and
 * is mutated so successive edits build a linear history per document.
 */
function generateEdits(random, clock, heads, docIds, count) {
  const docs = new Array(count)
  for (let i = 0; i < count; i++) {
    const docId = docIds[(random() * docIds.length) | 0]
    const versionId = makeId(random)
    docs[i] = {
      docId,
      versionId,
      links: [heads.get(docId)],
      updatedAt: clock(),
    }
    heads.set(docId, versionId)
  }
  return docs
}

/**
 * Generate pairs of concurrent edits (forks): two new versions that both
 * link to the current head of the same doc, then a merge version linking
 * both fork heads. Mutates `heads`.
 */
function generateForks(random, clock, heads, docIds, count) {
  const docs = []
  let i = 0
  while (docs.length < count) {
    const docId = docIds[i++ % docIds.length]
    const parent = heads.get(docId)
    const forkA = makeId(random)
    const forkB = makeId(random)
    const merge = makeId(random)
    docs.push(
      { docId, versionId: forkA, links: [parent], updatedAt: clock() },
      { docId, versionId: forkB, links: [parent], updatedAt: clock() },
      { docId, versionId: merge, links: [forkA, forkB], updatedAt: clock() },
    )
    heads.set(docId, merge)
  }
  return docs
}

/** Fisher-Yates shuffle (seeded) */
function shuffle(random, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (random() * (i + 1)) | 0
    const tmp = arr[i]
    arr[i] = arr[j]
    arr[j] = tmp
  }
  return arr
}

/**
 * Each scenario returns { setup, docs }: `setup` docs are indexed before
 * timing starts, `docs` are the docs indexed during the timed run.
 */
const scenarios = {
  create({ random, clock, docCount }) {
    return { setup: [], docs: generateCreates(random, clock, docCount) }
  },

  edit({ random, clock, docCount }) {
    const initialCount = Math.max(1, (docCount / 5) | 0)
    const initial = generateCreates(random, clock, initialCount)
    const heads = new Map(initial.map((d) => [d.docId, d.versionId]))
    const docIds = initial.map((d) => d.docId)
    return {
      setup: initial,
      docs: generateEdits(random, clock, heads, docIds, docCount),
    }
  },

  fork({ random, clock, docCount }) {
    const initialCount = Math.max(1, (docCount / 5) | 0)
    const initial = generateCreates(random, clock, initialCount)
    const heads = new Map(initial.map((d) => [d.docId, d.versionId]))
    const docIds = initial.map((d) => d.docId)
    return {
      setup: initial,
      docs: generateForks(random, clock, heads, docIds, docCount),
    }
  },

  sync({ random, clock, docCount }) {
    // Build a full history (creates + edits + forks), then shuffle it to
    // simulate out-of-order arrival during a sync with other peers.
    const createCount = Math.max(1, (docCount / 5) | 0)
    const editCount = Math.max(1, ((docCount * 3) / 5) | 0)
    const forkCount = Math.max(1, docCount - createCount - editCount)
    const initial = generateCreates(random, clock, createCount)
    const heads = new Map(initial.map((d) => [d.docId, d.versionId]))
    const docIds = initial.map((d) => d.docId)
    const docs = initial.concat(
      generateEdits(random, clock, heads, docIds, editCount),
      generateForks(random, clock, heads, docIds, forkCount),
    )
    return { setup: [], docs: shuffle(random, docs) }
  },
}

function runScenario(name, { docCount, batchSize, seed }) {
  const random = makeRandom(seed)
  const clock = makeClock()
  const { setup, docs } = scenarios[name]({ random, clock, docCount })

  const { indexer, cleanup } = createDb()
  for (let i = 0; i < setup.length; i += batchSize) {
    indexer.batch(setup.slice(i, i + batchSize))
  }

  const start = performance.now()
  for (let i = 0; i < docs.length; i += batchSize) {
    indexer.batch(docs.slice(i, i + batchSize))
  }
  const elapsedMs = performance.now() - start
  cleanup()
  return { docCount: docs.length, elapsedMs }
}

function main() {
  const args = process.argv.slice(2)
  const opts = { docs: 50000, batch: 100, repeat: 3 }
  const requested = []
  let json = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--json') json = true
    else if (arg === '--docs') opts.docs = Number(args[++i])
    else if (arg === '--batch') opts.batch = Number(args[++i])
    else if (arg === '--repeat') opts.repeat = Number(args[++i])
    else if (Object.hasOwn(scenarios, arg)) requested.push(arg)
    else {
      console.error(`Unknown argument: ${arg}`)
      console.error(
        `Usage: node bench.js [${Object.keys(scenarios).join('|')} ...] ` +
          '[--docs N] [--batch N] [--repeat N] [--json]',
      )
      process.exit(1)
    }
  }
  const names = requested.length > 0 ? requested : Object.keys(scenarios)

  const results = []
  for (const name of names) {
    // Warmup run (JIT, page cache) at a fraction of the size
    runScenario(name, {
      docCount: Math.max(1, (opts.docs / 10) | 0),
      batchSize: opts.batch,
      seed: 99,
    })
    const runs = []
    for (let i = 0; i < opts.repeat; i++) {
      runs.push(
        runScenario(name, {
          docCount: opts.docs,
          batchSize: opts.batch,
          seed: 42,
        }),
      )
    }
    const best = runs.reduce((a, b) => (a.elapsedMs < b.elapsedMs ? a : b))
    const mean = runs.reduce((sum, r) => sum + r.elapsedMs, 0) / runs.length
    results.push({
      scenario: name,
      docs: best.docCount,
      batchSize: opts.batch,
      meanMs: Math.round(mean),
      bestMs: Math.round(best.elapsedMs),
      docsPerSec: Math.round(best.docCount / (best.elapsedMs / 1000)),
    })
    if (!json) {
      const r = results[results.length - 1]
      console.log(
        `${name.padEnd(8)} ${String(r.docs).padStart(7)} docs  ` +
          `best ${String(r.bestMs).padStart(6)}ms  ` +
          `mean ${String(r.meanMs).padStart(6)}ms  ` +
          `${String(r.docsPerSec).padStart(7)} docs/sec`,
      )
    }
  }
  if (json) {
    console.log(JSON.stringify({ node: process.version, results }, null, 2))
  }
}

main()
