// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'
import { create } from './utils.js'

test('booleans, arrays and objects are transformed', async (t) => {
  const updatedAt = new Date(1999, 0, 1).toISOString()
  const docs = [
    {
      docId: 'A',
      versionId: '1',
      links: [],
      updatedAt,
      boolean: true,
      array: [],
      object: {},
    },
    {
      docId: 'B',
      versionId: '1',
      links: [],
      updatedAt,
      boolean: false,
      array: ['foo'],
      object: { foo: 'bar' },
    },
    { docId: 'C', versionId: '1', links: [], updatedAt, array: [], object: {} },
  ]

  const extraColumns = `
boolean INTEGER NOT NULL DEFAULT 0,
array TEXT NOT NULL,
object TEXT NOT NULL`

  const { indexer, db, cleanup } = create({ extraColumns })
  t.after(cleanup)

  indexer.batch(docs)

  const expected = [
    {
      docId: 'A',
      versionId: '1',
      links: '[]',
      forks: '[]',
      updatedAt,
      boolean: 1,
      array: '[]',
      object: '{}',
    },
    {
      docId: 'B',
      versionId: '1',
      links: '[]',
      forks: '[]',
      updatedAt,
      boolean: 0,
      array: '["foo"]',
      object: '{"foo":"bar"}',
    },
    {
      docId: 'C',
      versionId: '1',
      links: '[]',
      forks: '[]',
      updatedAt,
      boolean: 0,
      array: '[]',
      object: '{}',
    },
  ]

  assert.deepEqual(db.prepare('SELECT * FROM docs').all(), expected)
})

test('column defaults are applied as SQLite would store them', async (t) => {
  const updatedAt = new Date(1999, 0, 1).toISOString()

  // PRAGMA table_info returns defaults as raw SQL text (e.g. `'quoted'`
  // including the quotes), which must be parsed before being stored.
  // Expression defaults (e.g. CURRENT_TIMESTAMP) are not evaluated and
  // are stored as their SQL text.
  const extraColumns = `
text TEXT NOT NULL DEFAULT 'it''s quoted',
num REAL NOT NULL DEFAULT 1.5,
nullable TEXT DEFAULT NULL,
expr TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`

  const { indexer, db, cleanup } = create({ extraColumns })
  t.after(cleanup)

  indexer.batch([
    { docId: 'A', versionId: '1', links: [], updatedAt },
    {
      docId: 'B',
      versionId: '1',
      links: [],
      updatedAt,
      text: 'provided',
      num: 2,
      nullable: 'provided',
      expr: 'provided',
    },
  ])

  assert.deepEqual(
    db
      .prepare('SELECT text, num, nullable, expr FROM docs ORDER BY docId')
      .all(),
    [
      {
        text: "it's quoted",
        num: 1.5,
        nullable: null,
        expr: 'CURRENT_TIMESTAMP',
      },
      { text: 'provided', num: 2, nullable: 'provided', expr: 'provided' },
    ]
  )
})
