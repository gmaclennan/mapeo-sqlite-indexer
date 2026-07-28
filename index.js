// @ts-check
import assert from 'assert'

/**
 * @typedef {object} IndexableDocument
 * @property {string} docId
 * @property {string} versionId
 * @property {string[]} links
 * @property {string} updatedAt
 */

/** @typedef {{ type: string, pk: number, cid: number, notnull: 1 | 0, dflt_value: any, name: string }} ColumnInfo */
/** @typedef {Record<string, Partial<Omit<ColumnInfo, 'name'>>>} ColumnSchema */
/**
 * @template {IndexableDocument} [TDoc=IndexableDocument]
 * @typedef {TDoc & { forks: string[] }} IndexedDocument
 */
/** @typedef {{ version: string }} Backlink */
/**
 * @template {IndexableDocument} TDoc
 * @typedef {(doc: IndexedDocument<TDoc>) => void} IndexCallback
 */

/** @type {ColumnSchema} */
const docSchema = {
  docId: { type: 'TEXT', pk: 1, notnull: 1 },
  versionId: { type: 'TEXT', notnull: 1, pk: 0 },
  links: { type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
  forks: { type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
  updatedAt: { type: 'TEXT', notnull: 1, pk: 0 },
}

/** @type {ColumnSchema} */
const backlinkSchema = {
  versionId: { type: 'TEXT', pk: 1, notnull: 1 },
}

/**
 * The candidate table stores the full document of every version that is not
 * linked by another version, i.e. every possible head. This is what allows
 * getWinner to be (re-)run over all heads whenever the set changes, making
 * head selection independent of the order documents arrive in. The primary
 * key is (docId, versionId) so per-document lookup uses the primary key.
 *
 * @type {ColumnSchema}
 */
const candidateSchema = {
  docId: { type: 'TEXT', notnull: 1, pk: 1 },
  versionId: { type: 'TEXT', notnull: 1, pk: 2 },
  doc: { type: 'TEXT', notnull: 1, pk: 0 },
}

/**
 * @template {IndexableDocument} TDoc
 */
export class DbApi {
  #getDocSql
  #getDocFullSql
  #writeDocSql
  #updateForksSql
  #getBacklinkSql
  #hasBacklinkSql
  #writeBacklinkSql
  #getCandidatesSql
  #writeCandidateSql
  #deleteCandidateSql
  #deleteAll
  #writeColumns
  #docColumnNames

  /**
   * @param {import('better-sqlite3').Database} db
   * @param {object} options
   * @param {string} options.docTableName - Name of the Sqlite table that stores the indexed documents
   * @param {string} options.backlinkTableName - Name of the Sqlite table that stores the backlinks
   * @param {string} options.candidateTableName - Name of the Sqlite table that stores the head candidate documents
   */
  constructor(db, { docTableName, backlinkTableName, candidateTableName }) {
    assertValidSchema(db, {
      docTableName,
      backlinkTableName,
      candidateTableName,
    })
    const tableInfo = /** @type {ColumnInfo[]} */ (
      db.prepare(`PRAGMA table_info(${docTableName})`).all()
    )
    this.#writeColumns = tableInfo.map(({ name, dflt_value }) => ({
      name,
      dflt: parseSqlDefault(dflt_value),
    }))
    const docColumns = (this.#docColumnNames = tableInfo.map(
      ({ name }) => name,
    ))
    // .raw() rows (arrays) and positional (?) bindings are noticeably faster
    // than object rows and named (@) bindings in better-sqlite3
    this.#getDocSql = db
      .prepare(
        `SELECT docId, versionId, links, forks, updatedAt
      FROM ${docTableName}
      WHERE docId = ?`,
      )
      .raw(true)
    this.#getDocFullSql = db
      .prepare(
        `SELECT ${docColumns.join(',')}
      FROM ${docTableName}
      WHERE docId = ?`,
      )
      .raw(true)
    this.#writeDocSql = db.prepare(
      `REPLACE INTO ${docTableName} (${docColumns.join(',')})
      VALUES (${docColumns.map(() => '?').join(',')})`,
    )
    this.#updateForksSql = db.prepare(
      `UPDATE ${docTableName} SET forks = ? WHERE docId = ?`,
    )
    this.#getBacklinkSql = db.prepare(
      `SELECT versionId
      FROM ${backlinkTableName}
      WHERE versionId = ?`,
    )
    this.#hasBacklinkSql = db
      .prepare(
        `SELECT EXISTS (
        SELECT 1 FROM ${backlinkTableName} WHERE versionId = ?
      )`,
      )
      .pluck(true)
    this.#writeBacklinkSql = db.prepare(
      `INSERT OR IGNORE INTO ${backlinkTableName} (versionId)
      VALUES (?)`,
    )
    this.#getCandidatesSql = db
      .prepare(
        `SELECT versionId, doc
      FROM ${candidateTableName}
      WHERE docId = ?`,
      )
      .raw(true)
    this.#writeCandidateSql = db.prepare(
      `INSERT OR REPLACE INTO ${candidateTableName} (docId, versionId, doc)
      VALUES (?, ?, ?)`,
    )
    this.#deleteCandidateSql = db.prepare(
      `DELETE FROM ${candidateTableName} WHERE docId = ? AND versionId = ?`,
    )

    const deleteDocsSql = db.prepare(`DELETE FROM ${docTableName}`)
    const deleteBacklinksSql = db.prepare(`DELETE FROM ${backlinkTableName}`)
    const deleteCandidatesSql = db.prepare(`DELETE FROM ${candidateTableName}`)
    this.#deleteAll = db.transaction(() => {
      deleteDocsSql.run()
      deleteBacklinksSql.run()
      deleteCandidatesSql.run()
    })
  }
  /**
   * @param {string} docId
   * @returns {IndexedDocument | undefined}
   */
  getDoc(docId) {
    const row = /** @type {any} */ (this.#getDocSql.get(docId))
    if (!row) return
    return {
      docId: row[0],
      versionId: row[1],
      links: JSON.parse(row[2]),
      forks: JSON.parse(row[3]),
      updatedAt: row[4],
    }
  }
  /**
   * @param {TDoc | IndexedDocument<TDoc>} doc
   * @param {IndexedDocument<IndexableDocument>["forks"]} [forks] - Overrides
   * `doc.forks` if provided (avoids the caller needing to clone `doc`)
   */
  writeDoc(doc, forks) {
    const writeColumns = this.#writeColumns
    const values = new Array(writeColumns.length)
    for (let i = 0; i < writeColumns.length; i++) {
      const { name, dflt } = writeColumns[i]
      const value =
        name === 'forks' && forks !== undefined
          ? forks
          : /** @type {Record<string, any>} */ (doc)[name]
      if (value === null || typeof value === 'undefined') {
        values[i] = dflt
      } else if (typeof value === 'boolean') {
        values[i] = value ? 1 : 0
      } else if (typeof value === 'object') {
        values[i] = JSON.stringify(value)
      } else {
        values[i] = value
      }
    }
    this.#writeDocSql.run(values)
  }
  /**
   * The full stored row for a document (including any extra columns),
   * split into the document itself and its forks array. `links` is parsed
   * to an array; other column values are as stored (e.g. booleans as 1/0).
   * @param {string} docId
   * @returns {{ doc: TDoc, forks: string[] } | undefined}
   */
  getDocFull(docId) {
    const row = /** @type {any[] | undefined} */ (
      this.#getDocFullSql.get(docId)
    )
    if (!row) return
    const names = this.#docColumnNames
    /** @type {Record<string, any>} */
    const doc = {}
    /** @type {string[]} */
    let forks = []
    for (let i = 0; i < names.length; i++) {
      if (names[i] === 'forks') forks = JSON.parse(row[i])
      else if (names[i] === 'links') doc.links = JSON.parse(row[i])
      else doc[names[i]] = row[i]
    }
    return { doc: /** @type {TDoc} */ (doc), forks }
  }
  /**
   * @param {string} docId
   * @param {string[]} forks
   */
  updateForks(docId, forks) {
    this.#updateForksSql.run(JSON.stringify(forks), docId)
  }
  /**
   * All stored fork candidate documents of the given docId (one per entry
   * in the head's forks array)
   * @param {string} docId
   * @returns {Map<string, TDoc>} map of versionId → candidate document
   */
  getCandidates(docId) {
    /** @type {Map<string, TDoc>} */
    const candidates = new Map()
    for (const row of /** @type {any[][]} */ (
      this.#getCandidatesSql.all(docId)
    )) {
      candidates.set(row[0], JSON.parse(row[1]))
    }
    return candidates
  }
  /**
   * @param {TDoc} doc
   */
  writeCandidate(doc) {
    this.#writeCandidateSql.run(doc.docId, doc.versionId, JSON.stringify(doc))
  }
  /**
   * @param {string} docId
   * @param {string} versionId
   */
  deleteCandidate(docId, versionId) {
    this.#deleteCandidateSql.run(docId, versionId)
  }
  /**
   * @param {string} versionId
   */
  getBacklink(versionId) {
    return this.#getBacklinkSql.get(versionId)
  }
  /**
   * @param {string} versionId
   * @returns {boolean}
   */
  hasBacklink(versionId) {
    return !!this.#hasBacklinkSql.get(versionId)
  }
  /**
   * @param {string} versionId
   */
  writeBacklink(versionId) {
    this.#writeBacklinkSql.run(versionId)
  }
  /**
   * @returns {void}
   */
  deleteAll() {
    this.#deleteAll()
  }
}

/**
 * @template {IndexableDocument} [TDoc=IndexableDocument]
 */
export default class SqliteIndexer {
  #getWinner
  #dbApi

  /**
   * @param {import('better-sqlite3').Database} db
   * @param {object} options
   * @param {string} options.docTableName - Name of the Sqlite table that stores the indexed documents
   * @param {string} options.backlinkTableName - Name of the Sqlite table that stores the backlinks
   * @param {string} options.candidateTableName - Name of the Sqlite table that stores the head candidate documents
   * @param {typeof defaultGetWinner} [options.getWinner] - Function that will be used to determine the "winning" version of a forked document. Must be a deterministic total order over documents for indexing to be independent of the order documents arrive in.
   */
  constructor(
    db,
    {
      docTableName,
      backlinkTableName,
      candidateTableName,
      getWinner = defaultGetWinner,
    },
  ) {
    this.#dbApi = /** @type {DbApi<TDoc>} */ (
      new DbApi(db, { docTableName, backlinkTableName, candidateTableName })
    )
    this.#getWinner = getWinner
    /** @type {(docs: IndexableDocument[]) => void} */
    this.batch = db.transaction((docs) => this.#batch(docs))
  }

  /** @param {TDoc[]} docs */
  #batch(docs) {
    /**
     * Per-docId fork state for this batch. Fork candidate writes are
     * deferred to the end of the batch and only the net change is written,
     * because out-of-order arrival within a batch creates many transient
     * forks that resolve before the batch ends. `initialForks` is the
     * stored candidate rows when the docId was first recomputed in this
     * batch, `forkDocs` the docs of the current forks (kept in memory,
     * mirroring the forks column which IS updated eagerly).
     * @type {Map<string, { initialForks: string[], forkDocs: Map<string, TDoc> }>}
     */
    const forkStates = new Map()

    for (const doc of docs) {
      // Every version this doc links to is no longer a head
      for (const link of doc.links) {
        this.#dbApi.writeBacklink(link)
      }

      const existing = this.#dbApi.getDocFull(doc.docId)

      if (!existing) {
        // First indexed version of this document. If the doc is linked to
        // by another doc it's not a head, so we can ignore it: unlinked
        // versions of the document will be indexed as they arrive.
        if (!this.isLinked(doc.versionId)) {
          this.#dbApi.writeDoc(doc, [])
        }
        continue
      }

      const { doc: headDoc, forks: oldForks } = existing

      // The stored head and forks are unlinked: any already-indexed doc's
      // links were backlinked before its processing recomputed the head,
      // so only the current doc's links can newly link them.
      const headNowLinked = doc.links.includes(headDoc.versionId)
      const anyForkNowLinked = oldForks.some((versionId) =>
        doc.links.includes(versionId),
      )

      const docIsLinked = this.isLinked(doc.versionId)
      if (docIsLinked && !headNowLinked && !anyForkNowLinked) {
        // The doc is linked to by another doc (so it's not a head), and its
        // links change nothing about the current head or forks
        continue
      }

      // Build the set of head candidates: the current fork docs and head
      // that are still unlinked, plus this doc if it is unlinked. The full
      // doc of every fork is stored in the candidate table (mirroring the
      // head's forks array), so getWinner can be re-run over the whole set
      // whenever it changes.
      let forkState = forkStates.get(doc.docId)
      if (!forkState) {
        forkState = {
          initialForks: oldForks,
          forkDocs:
            oldForks.length > 0
              ? this.#dbApi.getCandidates(doc.docId)
              : new Map(),
        }
        forkStates.set(doc.docId, forkState)
      }
      /** @type {Map<string, TDoc>} */
      const candidates = new Map()
      for (const [versionId, forkDoc] of forkState.forkDocs) {
        // Forks linked by this doc are no longer heads
        if (!doc.links.includes(versionId)) {
          candidates.set(versionId, forkDoc)
        }
      }
      if (!headNowLinked) {
        candidates.set(headDoc.versionId, headDoc)
      }
      if (!candidates.has(doc.versionId) && !docIsLinked) {
        candidates.set(doc.versionId, doc)
      }

      if (candidates.size === 0) {
        // No unlinked version of this document is known, which is only
        // possible with links that do not point to earlier versions of the
        // same document: leave the currently indexed head in place
        continue
      }

      // Select the winner among all candidates. Candidates are sorted so
      // that the fold over getWinner is deterministic; with a total-order
      // getWinner the result is the maximum of the set, so the indexed
      // head does not depend on the order documents arrive in.
      const sorted = [...candidates.values()].sort((a, b) =>
        a.versionId < b.versionId ? -1 : 1,
      )
      let winner = sorted[0]
      for (let i = 1; i < sorted.length; i++) {
        winner = this.#getWinner(winner, sorted[i])
      }
      /** @type {string[]} */
      const forks = []
      for (const candidate of sorted) {
        if (candidate.versionId !== winner.versionId) {
          forks.push(candidate.versionId)
        }
      }

      // Nothing to write if the head and forks are unchanged (e.g. the
      // same data was re-synced or re-indexed)
      if (
        winner.versionId === headDoc.versionId &&
        forks.length === oldForks.length &&
        forks.every((versionId, i) => versionId === oldForks[i])
      ) {
        continue
      }

      // Track the new fork docs in memory; the candidate table is synced
      // at the end of the batch
      /** @type {Map<string, TDoc>} */
      const forkDocs = new Map()
      for (const versionId of forks) {
        forkDocs.set(versionId, /** @type {TDoc} */ (candidates.get(versionId)))
      }
      forkState.forkDocs = forkDocs

      if (winner.versionId === headDoc.versionId) {
        this.#dbApi.updateForks(doc.docId, forks)
      } else {
        this.#dbApi.writeDoc(winner, forks)
      }
    }

    // Sync the stored fork candidates to the net change for each document
    // touched by this batch
    for (const [docId, { initialForks, forkDocs }] of forkStates) {
      for (const versionId of initialForks) {
        if (!forkDocs.has(versionId)) {
          this.#dbApi.deleteCandidate(docId, versionId)
        }
      }
      for (const [versionId, forkDoc] of forkDocs) {
        if (!initialForks.includes(versionId)) {
          this.#dbApi.writeCandidate(forkDoc)
        }
      }
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

/**
 * @template {IndexableDocument} T
 * @template {IndexableDocument} U
 * @param {T} docA
 * @param {U} docB
 * @returns T | U
 */
export function defaultGetWinner(docA, docB) {
  if (docA.updatedAt > docB.updatedAt) return docA
  if (docB.updatedAt > docA.updatedAt) return docB
  // They are equal or no timestamp property, so sort by version to ensure winner is deterministic
  return docA.versionId > docB.versionId ? docA : docB
}

/**
 * `PRAGMA table_info` returns a column's default as raw SQL text (e.g. the
 * five characters `'foo'` for `DEFAULT 'foo'`), so parse it into the value
 * that SQLite itself would store. Expression defaults (e.g.
 * CURRENT_TIMESTAMP) are not evaluated and are stored as their SQL text.
 *
 * @param {any} dfltValue
 * @returns {string | number | null}
 */
function parseSqlDefault(dfltValue) {
  if (dfltValue == null || /^NULL$/i.test(dfltValue)) return null
  const str = /^'(.*)'$/s.exec(dfltValue)
  if (str) return str[1].replace(/''/g, "'")
  const num = Number(dfltValue)
  return Number.isNaN(num) ? dfltValue : num
}

/**
 * Assert that the given sqlite database has tables with the correct schema for
 * indexing Mapeo data
 *
 * @param {ConstructorParameters<typeof SqliteIndexer>[0]} db
 * @param {Omit<ConstructorParameters<typeof SqliteIndexer>[1], "getWinner">} options
 */
function assertValidSchema(
  db,
  { docTableName, backlinkTableName, candidateTableName },
) {
  const docsTable = db.prepare(`PRAGMA table_list(${docTableName})`).get()
  assert(docsTable, `Table ${docTableName} does not exist`)
  const docsColumns = /** @type {ColumnInfo[]} */ (
    db.prepare(`PRAGMA table_info(${docTableName})`).all()
  )
  assertMatchingSchema(docTableName, docsColumns, docSchema)
  const backlinksTable = /** @type {{ ncol: number } | undefined }} */ (
    db.prepare(`PRAGMA table_list(${backlinkTableName})`).get()
  )
  assert(backlinksTable, `Table ${backlinkTableName} does not exist`)
  assert(
    backlinksTable.ncol === 1,
    `Backlinks table should have 1 column, but instead had ${backlinksTable.ncol}`,
  )
  const backlinksColumns = /** @type {ColumnInfo[]} */ (
    db.prepare(`PRAGMA table_info(${backlinkTableName})`).all()
  )
  assertMatchingSchema(backlinkTableName, backlinksColumns, backlinkSchema)
  const candidatesTable = db
    .prepare(`PRAGMA table_list(${candidateTableName})`)
    .get()
  assert(candidatesTable, `Table ${candidateTableName} does not exist`)
  const candidatesColumns = /** @type {ColumnInfo[]} */ (
    db.prepare(`PRAGMA table_info(${candidateTableName})`).all()
  )
  assertMatchingSchema(candidateTableName, candidatesColumns, candidateSchema)
}

/**
 * @param {string} tableName
 * @param {ColumnInfo[]} columns
 * @param {ColumnSchema} schema
 */
function assertMatchingSchema(tableName, columns, schema) {
  for (const [name, info] of Object.entries(schema)) {
    const column = columns.find((c) => c.name === name)
    assert(column, `Table '${tableName}' must have a column '${name}'`)
    for (const [prop, value] of Object.entries(info)) {
      assert(
        // @ts-ignore
        column[prop] === value,
        // @ts-ignore
        `Column '${name}' in table '${tableName}' should have ${prop}=${value}, but instead ${prop}=${column[prop]}`,
      )
    }
  }
}
