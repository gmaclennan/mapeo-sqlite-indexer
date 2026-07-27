// @ts-check
// PROTOTYPE: set-based implementation of SqliteIndexer
//
// Instead of running ~4 prepared statements per document (get existing doc,
// write backlinks, check linked-ness, write doc), this implementation runs a
// fixed number of *batched* statements per batch() call:
//
//   1. One (chunked) SELECT to load the existing head for every docId in
//      the batch
//   2. One (chunked) multi-row INSERT OR IGNORE for every link in the batch
//   3. One (chunked) SELECT against the backlinks table to find which
//      candidate versionIds are linked
//   4. The head-selection algorithm runs purely in memory
//   5. One (chunked) multi-row REPLACE to write every changed head
//
// Statements are chunked to a fixed size and padded (repeating the last
// value) so that prepared statements can be cached and reused: SQLite
// ignores duplicate values in an IN list, INSERT OR IGNORE ignores
// duplicate rows, and REPLACE of an identical row is idempotent.
//
// Run the test suite against this implementation with:
//   INDEXER_IMPL=../index-batched.js npx borp
// Benchmark it with:
//   INDEXER_IMPL=./index-batched.js node bench.js

import { DbApi, defaultGetWinner } from './index.js'

/** @typedef {import('./index.js').IndexableDocument} IndexableDocument */
/**
 * @template {IndexableDocument} [TDoc=IndexableDocument]
 * @typedef {import('./index.js').IndexedDocument<TDoc>} IndexedDocument
 */

// Number of values bound per chunked statement. IN-lists and multi-row
// inserts are padded to this size so each statement shape is prepared once.
const CHUNK = 256

// PRAGMA table_info returns defaults as raw SQL text; parse to the value
// SQLite would store (same logic as index.js)
function parseSqlDefault(dfltValue) {
  if (dfltValue == null || /^NULL$/i.test(dfltValue)) return null
  const str = /^'(.*)'$/s.exec(dfltValue)
  if (str) return str[1].replace(/''/g, "'")
  const num = Number(dfltValue)
  return Number.isNaN(num) ? dfltValue : num
}

/**
 * @template {IndexableDocument} [TDoc=IndexableDocument]
 */
export default class SqliteIndexerBatched {
  #getWinner
  #dbApi
  #db
  #docTableName
  #backlinkTableName
  #docColumns
  #tableInfo
  #getDocsSql
  #getLinkedSql
  #writeBacklinksSql
  /** @type {Map<number, import('better-sqlite3').Statement>} */
  #writeDocsSqlCache = new Map()

  /**
   * @param {import('better-sqlite3').Database} db
   * @param {object} options
   * @param {string} options.docTableName - Name of the Sqlite table that stores the indexed documents
   * @param {string} options.backlinkTableName - Name of the Sqlite table that stores the backlinks
   * @param {typeof defaultGetWinner} [options.getWinner] - Function that will be used to determine the "winning" fork of a document
   */
  constructor(
    db,
    { docTableName, backlinkTableName, getWinner = defaultGetWinner }
  ) {
    // DbApi validates the schema; also reused for getDoc/deleteAll parity
    this.#dbApi = new DbApi(db, { docTableName, backlinkTableName })
    this.#db = db
    this.#docTableName = docTableName
    this.#backlinkTableName = backlinkTableName
    this.#getWinner = getWinner

    this.#tableInfo =
      /** @type {{ name: string, dflt: any }[]} */
      (
        db
          .prepare(`PRAGMA table_info(${docTableName})`)
          .all()
          .map((col) => ({ ...col, dflt: parseSqlDefault(col.dflt_value) }))
      )
    this.#docColumns = this.#tableInfo.map(({ name }) => name)

    const placeholders = new Array(CHUNK).fill('?').join(',')
    this.#getDocsSql = db
      .prepare(
        `SELECT docId, versionId, links, forks, updatedAt
        FROM ${docTableName}
        WHERE docId IN (${placeholders})`
      )
      .raw(true)
    this.#getLinkedSql = db
      .prepare(
        `SELECT versionId FROM ${backlinkTableName}
        WHERE versionId IN (${placeholders})`
      )
      .pluck(true)
    this.#writeBacklinksSql = db.prepare(
      `INSERT OR IGNORE INTO ${backlinkTableName} (versionId)
      VALUES ${new Array(CHUNK).fill('(?)').join(',')}`
    )

    /** @type {(docs: TDoc[]) => void} */
    this.batch = db.transaction((docs) => this.#batch(docs))
  }

  /**
   * Iterate `values` in CHUNK-sized slices, padding the last slice by
   * repeating its final value, and call fn(chunkArray) for each.
   * @param {string[]} values
   * @param {(chunk: string[]) => void} fn
   */
  #chunked(values, fn) {
    for (let i = 0; i < values.length; i += CHUNK) {
      let chunk = values.slice(i, i + CHUNK)
      if (chunk.length < CHUNK) {
        const last = chunk[chunk.length - 1]
        while (chunk.length < CHUNK) chunk.push(last)
      }
      fn(chunk)
    }
  }

  /**
   * Load existing indexed heads for the given docIds
   * @param {string[]} docIds
   * @returns {Map<string, IndexedDocument<TDoc>>}
   */
  #getDocs(docIds) {
    /** @type {Map<string, IndexedDocument<TDoc>>} */
    const heads = new Map()
    this.#chunked(docIds, (chunk) => {
      const rows = /** @type {any[][]} */ (this.#getDocsSql.all(chunk))
      for (const row of rows) {
        heads.set(
          row[0],
          /** @type {any} */ ({
            docId: row[0],
            versionId: row[1],
            links: JSON.parse(row[2]),
            forks: JSON.parse(row[3]),
            updatedAt: row[4],
          })
        )
      }
    })
    return heads
  }

  /**
   * Which of the given versionIds have a backlink (i.e. are linked)?
   * @param {string[]} versionIds
   * @returns {Set<string>}
   */
  #getLinked(versionIds) {
    /** @type {Set<string>} */
    const linked = new Set()
    this.#chunked(versionIds, (chunk) => {
      for (const versionId of /** @type {string[]} */ (
        this.#getLinkedSql.all(chunk)
      )) {
        linked.add(versionId)
      }
    })
    return linked
  }

  /** @param {string[]} links */
  #writeBacklinks(links) {
    this.#chunked(links, (chunk) => {
      this.#writeBacklinksSql.run(chunk)
    })
  }

  /**
   * Write the given heads with a multi-row REPLACE (one statement per
   * up-to-CHUNK rows, cached per row-count to avoid re-preparing)
   * @param {IndexedDocument<TDoc>[]} heads
   */
  #writeDocs(heads) {
    const tableInfo = this.#tableInfo
    const ncols = tableInfo.length
    // Rows per statement, bounded so total bound variables stay ≤ CHUNK×2
    const maxRows = Math.max(1, Math.floor((CHUNK * 2) / ncols))
    for (let i = 0; i < heads.length; i += maxRows) {
      const rows = heads.slice(i, i + maxRows)
      let stmt = this.#writeDocsSqlCache.get(rows.length)
      if (!stmt) {
        const row = `(${new Array(ncols).fill('?').join(',')})`
        stmt = this.#db.prepare(
          `REPLACE INTO ${this.#docTableName}
          (${this.#docColumns.join(',')})
          VALUES ${new Array(rows.length).fill(row).join(',')}`
        )
        this.#writeDocsSqlCache.set(rows.length, stmt)
      }
      const values = new Array(rows.length * ncols)
      let v = 0
      for (const head of rows) {
        for (let c = 0; c < ncols; c++) {
          const { name, dflt } = tableInfo[c]
          const value = /** @type {Record<string, any>} */ (head)[name]
          if (value === null || typeof value === 'undefined') {
            values[v++] = dflt
          } else if (typeof value === 'boolean') {
            values[v++] = value ? 1 : 0
          } else if (typeof value === 'object') {
            values[v++] = JSON.stringify(value)
          } else {
            values[v++] = value
          }
        }
      }
      stmt.run(values)
    }
  }

  /** @param {TDoc[]} docs */
  #batch(docs) {
    if (docs.length === 0) return

    // 1. Collect unique docIds, links, and versionIds that need a
    // linked-ness lookup
    /** @type {Set<string>} */
    const docIds = new Set()
    /** @type {Set<string>} */
    const links = new Set()
    /** @type {Set<string>} */
    const versionCandidates = new Set()
    for (const doc of docs) {
      docIds.add(doc.docId)
      versionCandidates.add(doc.versionId)
      for (const link of doc.links) links.add(link)
    }

    // 2. Load existing heads for every docId in the batch
    const heads = this.#getDocs([...docIds])
    for (const head of heads.values()) {
      versionCandidates.add(head.versionId)
      for (const fork of head.forks) versionCandidates.add(fork)
    }

    // 3. Write all backlinks, then 4. look up which candidate versions are
    // linked (including links written by this batch)
    if (links.size > 0) this.#writeBacklinks([...links])
    const linked = this.#getLinked([...versionCandidates])

    // 5. Run the head-selection algorithm in memory. This is the same
    // algorithm as SqliteIndexer.#batch, except that linked-ness reflects
    // *all* links in this batch rather than only those seen so far, which
    // converges to the same result (indexing is arrival-order independent).
    /** @type {Set<string>} */
    const dirty = new Set()
    for (const doc of docs) {
      const existing = heads.get(doc.docId)

      if (existing) {
        // Prune forks that are now linked
        const pruned = existing.forks.filter((fork) => !linked.has(fork))
        if (pruned.length !== existing.forks.length) {
          existing.forks = pruned
          dirty.add(doc.docId)
        }
      }

      // If the doc is linked to by another doc, it's not a head: ignore it
      if (linked.has(doc.versionId)) continue

      if (!existing) {
        heads.set(doc.docId, /** @type {any} */ ({ ...doc, forks: [] }))
        dirty.add(doc.docId)
      } else if (
        existing.versionId === doc.versionId ||
        existing.forks.includes(doc.versionId)
      ) {
        // This version is already indexed: nothing new to index
        continue
      } else if (linked.has(existing.versionId)) {
        // The existing head is now linked, so this doc replaces it,
        // inheriting any still-unresolved forks
        heads.set(
          doc.docId,
          /** @type {any} */ ({ ...doc, forks: existing.forks })
        )
        dirty.add(doc.docId)
      } else {
        // Document is forked, so we need to select a "winner"
        const winner = this.#getWinner(existing, doc)
        if (winner === existing) {
          existing.forks.push(doc.versionId)
          dirty.add(doc.docId)
        } else {
          existing.forks.push(existing.versionId)
          heads.set(
            doc.docId,
            /** @type {any} */ ({ ...doc, forks: existing.forks })
          )
          dirty.add(doc.docId)
        }
      }
    }

    // 6. Flush changed heads
    if (dirty.size > 0) {
      this.#writeDocs(
        [...dirty].map((id) => /** @type {any} */ (heads.get(id)))
      )
    }
  }

  /** @param {string} versionId */
  isLinked(versionId) {
    return this.#dbApi.hasBacklink(versionId)
  }

  deleteAll() {
    this.#dbApi.deleteAll()
  }
}
