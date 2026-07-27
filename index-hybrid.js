// @ts-check
// PROTOTYPE: hybrid implementation of SqliteIndexer
//
// Measuring the full set-based prototype (index-batched.js) showed that
// batching *reads* loses to SQLite point lookups, but coalescing *writes*
// wins when a batch contains several versions of the same document. This
// hybrid keeps the per-document point reads of index.js, but:
//
// - Tracks the evolving head of each document in memory during the batch,
//   writing each changed head once per batch (multi-row REPLACE) instead
//   of on every version processed
// - Defers backlink writes to one multi-row INSERT OR IGNORE per batch,
//   consulting the in-memory pending set plus a point query for
//   linked-ness checks during processing
//
// Run the test suite against this implementation with:
//   INDEXER_IMPL=../index-hybrid.js npx borp
// Benchmark it with:
//   INDEXER_IMPL=./index-hybrid.js node bench.js

import { DbApi, defaultGetWinner } from './index.js'

/** @typedef {import('./index.js').IndexableDocument} IndexableDocument */
/**
 * @template {IndexableDocument} [TDoc=IndexableDocument]
 * @typedef {import('./index.js').IndexedDocument<TDoc>} IndexedDocument
 */

// Maximum rows per multi-row write statement
const MAX_ROWS = 256

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
export default class SqliteIndexerHybrid {
  #getWinner
  #dbApi
  #db
  #docTableName
  #backlinkTableName
  #docColumns
  #tableInfo
  /** @type {Map<number, import('better-sqlite3').Statement>} */
  #writeBacklinksSqlCache = new Map()
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
    // DbApi validates the schema; also used for point reads
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

    /** @type {(docs: TDoc[]) => void} */
    this.batch = db.transaction((docs) => this.#batch(docs))
  }

  /** @param {string[]} links */
  #writeBacklinks(links) {
    for (let i = 0; i < links.length; i += MAX_ROWS) {
      const chunk = links.slice(i, i + MAX_ROWS)
      let stmt = this.#writeBacklinksSqlCache.get(chunk.length)
      if (!stmt) {
        stmt = this.#db.prepare(
          `INSERT OR IGNORE INTO ${this.#backlinkTableName} (versionId)
          VALUES ${new Array(chunk.length).fill('(?)').join(',')}`
        )
        this.#writeBacklinksSqlCache.set(chunk.length, stmt)
      }
      stmt.run(chunk)
    }
  }

  /**
   * Write the given heads with a multi-row REPLACE
   * @param {IndexedDocument<TDoc>[]} heads
   */
  #writeDocs(heads) {
    const tableInfo = this.#tableInfo
    const ncols = tableInfo.length
    const maxRows = Math.max(1, Math.floor((MAX_ROWS * 2) / ncols))
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

    /**
     * Evolving head per docId seen in this batch (null = no head yet)
     * @type {Map<string, IndexedDocument<TDoc> | undefined>}
     */
    const heads = new Map()
    /** @type {Set<string>} - backlinks to write at the end of the batch */
    const pendingLinks = new Set()
    /** @type {Set<string>} - docIds whose head changed */
    const dirty = new Set()
    /**
     * docIds whose current head object was loaded from the DB (so only its
     * forks may have changed). These are flushed with a forks-only UPDATE:
     * a full REPLACE would wipe user-defined extra columns, which are not
     * loaded by getDoc.
     * @type {Set<string>}
     */
    const fromDb = new Set()

    /** @param {string} versionId */
    const isLinked = (versionId) =>
      pendingLinks.has(versionId) || this.#dbApi.hasBacklink(versionId)

    for (const doc of docs) {
      /** @type {IndexedDocument<TDoc> | undefined} */
      let existing
      if (heads.has(doc.docId)) {
        existing = heads.get(doc.docId)
      } else {
        existing = /** @type {IndexedDocument<TDoc> | undefined} */ (
          this.#dbApi.getDoc(doc.docId)
        )
        heads.set(doc.docId, existing)
        if (existing) fromDb.add(doc.docId)
      }

      for (const link of doc.links) {
        pendingLinks.add(link)
        if (existing && existing.forks.includes(link)) {
          dirty.add(doc.docId)
          existing.forks = existing.forks.filter((fork) => fork !== link)
        }
      }

      // If the doc is linked to by another doc, it's not a head: ignore it
      if (isLinked(doc.versionId)) continue

      if (!existing) {
        heads.set(doc.docId, /** @type {any} */ ({ ...doc, forks: [] }))
        fromDb.delete(doc.docId)
        dirty.add(doc.docId)
      } else if (
        existing.versionId === doc.versionId ||
        existing.forks.includes(doc.versionId)
      ) {
        // This version is already indexed: nothing new to index
        continue
      } else if (isLinked(existing.versionId)) {
        // The existing head is now linked, so this doc replaces it,
        // inheriting any still-unresolved forks
        heads.set(
          doc.docId,
          /** @type {any} */ ({ ...doc, forks: existing.forks })
        )
        fromDb.delete(doc.docId)
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
          fromDb.delete(doc.docId)
          dirty.add(doc.docId)
        }
      }
    }

    if (pendingLinks.size > 0) this.#writeBacklinks([...pendingLinks])
    /** @type {any[]} */
    const replacedHeads = []
    for (const id of dirty) {
      const head = /** @type {any} */ (heads.get(id))
      if (fromDb.has(id)) {
        // Only forks changed on a head loaded from the DB: a full REPLACE
        // would wipe user-defined extra columns (not loaded by getDoc)
        this.#dbApi.updateForks(id, head.forks)
      } else {
        replacedHeads.push(head)
      }
    }
    if (replacedHeads.length > 0) this.#writeDocs(replacedHeads)
  }

  /** @param {string} versionId */
  isLinked(versionId) {
    return this.#dbApi.hasBacklink(versionId)
  }

  deleteAll() {
    this.#dbApi.deleteAll()
  }
}
