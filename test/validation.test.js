// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import SqliteIndexer from '../index.js'

const VALID_DOCS_TABLE = `CREATE TABLE docs (
  docId TEXT PRIMARY KEY NOT NULL,
  versionId TEXT NOT NULL,
  links TEXT NOT NULL,
  forks TEXT NOT NULL,
  updatedAt TEXT NOT NULL
) WITHOUT ROWID`

const VALID_BACKLINKS_TABLE = `CREATE TABLE backlinks
  (versionId TEXT PRIMARY KEY NOT NULL) WITHOUT ROWID`

/** @param {string[]} statements */
function createDb(...statements) {
  const db = new Database(':memory:')
  for (const sql of statements) db.prepare(sql).run()
  return db
}

/** @param {import('better-sqlite3').Database} db */
function createIndexer(db) {
  return new SqliteIndexer(db, {
    docTableName: 'docs',
    backlinkTableName: 'backlinks',
  })
}

test('throws if the docs table does not exist', () => {
  const db = createDb(VALID_BACKLINKS_TABLE)
  assert.throws(() => createIndexer(db), /Table docs does not exist/)
})

test('throws if the backlinks table does not exist', () => {
  const db = createDb(VALID_DOCS_TABLE)
  assert.throws(() => createIndexer(db), /Table backlinks does not exist/)
})

test('throws if the backlinks table has extra columns', () => {
  const db = createDb(
    VALID_DOCS_TABLE,
    `CREATE TABLE backlinks (
      versionId TEXT PRIMARY KEY NOT NULL,
      extra TEXT
    ) WITHOUT ROWID`
  )
  assert.throws(() => createIndexer(db), /should have 1 column/)
})

test('throws if a required column is missing from the docs table', () => {
  const db = createDb(
    `CREATE TABLE docs (
      docId TEXT PRIMARY KEY NOT NULL,
      versionId TEXT NOT NULL,
      links TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    ) WITHOUT ROWID`,
    VALID_BACKLINKS_TABLE
  )
  assert.throws(() => createIndexer(db), /must have a column 'forks'/)
})

test('throws if a docs column has the wrong type', () => {
  const db = createDb(
    `CREATE TABLE docs (
      docId INTEGER PRIMARY KEY NOT NULL,
      versionId TEXT NOT NULL,
      links TEXT NOT NULL,
      forks TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )`,
    VALID_BACKLINKS_TABLE
  )
  assert.throws(() => createIndexer(db), /should have type=TEXT/)
})

test('throws if a docs column is nullable', () => {
  const db = createDb(
    `CREATE TABLE docs (
      docId TEXT PRIMARY KEY NOT NULL,
      versionId TEXT,
      links TEXT NOT NULL,
      forks TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    ) WITHOUT ROWID`,
    VALID_BACKLINKS_TABLE
  )
  assert.throws(() => createIndexer(db), /should have notnull=1/)
})

test('throws if the wrong column is the primary key', () => {
  const db = createDb(
    `CREATE TABLE docs (
      docId TEXT NOT NULL,
      versionId TEXT PRIMARY KEY NOT NULL,
      links TEXT NOT NULL,
      forks TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    ) WITHOUT ROWID`,
    VALID_BACKLINKS_TABLE
  )
  assert.throws(() => createIndexer(db))
})

test('a valid schema with extra columns is accepted', () => {
  const db = createDb(
    `CREATE TABLE docs (
      docId TEXT PRIMARY KEY NOT NULL,
      versionId TEXT NOT NULL,
      links TEXT NOT NULL,
      forks TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      extra TEXT
    ) WITHOUT ROWID`,
    VALID_BACKLINKS_TABLE
  )
  assert.doesNotThrow(() => createIndexer(db))
})
