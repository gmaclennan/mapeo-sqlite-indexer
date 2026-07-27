# @mapeo/sqlite-indexer

[![Node.js CI](https://github.com/digidem/mapeo-sqlite-indexer/workflows/Node.js%20CI/badge.svg)](https://github.com/digidem/mapeo-sqlite-indexer/actions/workflows/node.js.yml)
[![Coverage Status](https://coveralls.io/repos/github/digidem/mapeo-sqlite-indexer/badge.svg)](https://coveralls.io/github/digidem/mapeo-sqlite-indexer)
[![Npm package version](https://img.shields.io/npm/v/@mapeo/sqlite-indexer)](https://npmjs.com/package/@mapeo/sqlite-indexer)

Index Mapeo data in a [SQLite](https://sqlite.org/) database.

Mapeo data is stored in multiple append-only logs (we use [Hypercore](https://github.com/hypercore-protocol/hypercore-next)). The data is structured as a Directed Acyclic Graph (DAG) for each document `docId`: each edit of a particular document is stored as a new version that `links` to the `versionId`(s) of its parent(s). This can result in "forks": the same parent can be edited in two different instances of Mapeo, resulting in two versions of the same document.

This indexer accepts batches of Mapeo documents of a particular type (namespace) and indexes the "head" version of each document. If a document is forked then a "winner" is chosen deterministically, by default by comparing `updatedAt` timestamps (with ties broken by comparing `versionId`s). The document heads are stored in a [SQLite](https://sqlite.org/) database, so that further querying and indexing of the documents is done within SQLite.

Any document that is indexed must have the following type:

```ts
type IndexableDocument = {
  docId: string
  versionId: string
  links: string[]
  updatedAt: string
  [otherProp: string]: any
}
```

`versionId` must be unique, `links` is an array of the `versionId`s of the document's parent(s), and `updatedAt` is a timestamp of when the version was created (an ISO 8601 string works well, since the default winner selection compares `updatedAt` values as strings).

The SQLite database must include a table for storing these documents that must at a minimum include these columns (with these exact types, `NOT NULL` constraints and primary key), but can contain additional columns:

```sql
CREATE TABLE IF NOT EXISTS docs
  (
    docId TEXT PRIMARY KEY NOT NULL,
    versionId TEXT NOT NULL,
    links TEXT NOT NULL,
    forks TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  )
```

The database must also include a table for storing "backlinks" (used internally for indexing which versions are already linked). It must have exactly one column:

```sql
  CREATE TABLE IF NOT EXISTS backlinks
    (versionId TEXT PRIMARY KEY NOT NULL)
```

And a table for storing "candidates" (used internally to store every version that could currently be the head, so that the winning head can be re-selected as new versions arrive, independent of the order they arrive in):

```sql
  CREATE TABLE IF NOT EXISTS candidates
    (
      docId TEXT NOT NULL,
      versionId TEXT NOT NULL,
      doc TEXT NOT NULL,
      PRIMARY KEY (docId, versionId)
    )
```

For maximum performance, activate [Write-Ahead Logging](https://sqlite.org/wal.html) and create the tables [`WITHOUT ROWID`](https://sqlite.org/withoutrowid.html).

## Table of Contents

- [Install](#install)
- [Usage](#usage)
- [API](#api)
- [Benchmarks](#benchmarks)
- [Upgrading from v1](#upgrading-from-v1)
- [Maintainers](#maintainers)
- [Contributing](#contributing)
- [License](#license)

## Install

```
npm install @mapeo/sqlite-indexer
```

Requires Node.js `>=18.17.1`. [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) is a peer dependency, so you must install it yourself; any version works with this library, but note that the version you choose may have its own Node.js requirements (e.g. better-sqlite3 v13 requires Node.js 22 or later).

## Usage

```js
import Database from 'better-sqlite3'
import SqliteIndexer from '@mapeo/sqlite-indexer'

const db = new Database(':memory:')

// Recommended for performance with file-backed databases
db.pragma('journal_mode = WAL')

db.prepare(
  `CREATE TABLE IF NOT EXISTS docs
  (
    docId TEXT PRIMARY KEY NOT NULL,
    versionId TEXT NOT NULL,
    links TEXT NOT NULL,
    forks TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  )
  WITHOUT ROWID`,
).run()

db.prepare(
  `CREATE TABLE IF NOT EXISTS backlinks
  (versionId TEXT PRIMARY KEY NOT NULL)
  WITHOUT ROWID`,
).run()

db.prepare(
  `CREATE TABLE IF NOT EXISTS candidates
  (
    docId TEXT NOT NULL,
    versionId TEXT NOT NULL,
    doc TEXT NOT NULL,
    PRIMARY KEY (docId, versionId)
  )
  WITHOUT ROWID`,
).run()

const docs = [
  { docId: 'A', versionId: '1', links: [], updatedAt: '2023-01-01T00:00:01Z' },
  {
    docId: 'A',
    versionId: '2',
    links: ['1'],
    updatedAt: '2023-01-01T00:00:02Z',
  },
  {
    docId: 'A',
    versionId: '3',
    links: ['1'],
    updatedAt: '2023-01-01T00:00:03Z',
  },
  {
    docId: 'A',
    versionId: '4',
    links: ['2', '3'],
    updatedAt: '2023-01-01T00:00:04Z',
  },
]

const indexer = new SqliteIndexer(db, {
  docTableName: 'docs',
  backlinkTableName: 'backlinks',
  candidateTableName: 'candidates',
})

indexer.batch(docs)

const A = db.prepare('SELECT * FROM docs WHERE docId = ?').get('A')
console.log(A)
// {
//   docId: 'A',
//   versionId: '4',
//   links: '["2","3"]',
//   forks: '[]',
//   updatedAt: '2023-01-01T00:00:04Z'
// }
```

## API

### const indexer = new SqliteIndexer(db, opts)

The constructor checks that the tables named by `opts.docTableName`, `opts.backlinkTableName` and `opts.candidateTableName` exist and have the required columns (see above), and throws if they do not.

### db

_Required_\
Type: `BetterSqlite3.Database`

An instance of a [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) database.

### opts

_Required_\
Type: `object`

#### opts.docTableName

_Required_\
Type: `string`

The name of the table for storing the indexed documents.

#### opts.backlinkTableName

_Required_\
Type: `string`

The name of the table for storing backlinks (used internally for indexing).

#### opts.candidateTableName

_Required_\
Type: `string`

The name of the table for storing head candidates (used internally for indexing).

#### opts.getWinner

_Optional_\
Type: `(docA, docB) => docA | docB`

Function used to determine the "winning" version when a document is forked. It is called with two documents and must return one of them. By default the version with the later `updatedAt` value wins, with ties broken by choosing the higher `versionId` (comparing strings). The head of a document is the `getWinner`-maximum over all of its current candidates (unlinked versions), so provided `getWinner` is a deterministic [total order](https://en.wikipedia.org/wiki/Total_order) (the default is), the indexed head does not depend on the order documents are indexed in — including when device clocks are skewed or `updatedAt` values tie.

### indexer.batch(docs)

Index an array of documents (runs in a single SQLite transaction). Documents can be in any order — parents may arrive before or after their children. Each document must have a `docId` property, a `versionId` property that is unique, a `links` property which is an array of the `versionId`s of the document's parent(s), and an `updatedAt` property.

Additional properties are stored in the SQLite table if a column with a matching name exists (properties without a matching column are ignored). Values are stored as follows:

- `links` and `forks` are stored as JSON-encoded arrays, e.g. `'["2","3"]'`.
- Booleans are stored as `1` or `0`.
- Objects and arrays in extra columns are stored JSON-stringified.
- Missing (`undefined`) or `null` values are stored as the column's SQL `DEFAULT` value (or `NULL` if the column has no default).

The document stored in SQLite will have a `forks` column which is a JSON-encoded array of the `versionId`s of other forks of the document, if any exist (an empty array `'[]'` otherwise).

### indexer.deleteAll()

Delete all documents, backlinks and candidates. Useful if you want to reset the index.

## Benchmarks

Run `npm run bench` to benchmark the indexer across several realistic scenarios (initial creates, linear edits, forks, and out-of-order sync) — see the header of [`bench.js`](./bench.js) for options. Findings from profiling and benchmarking are written up in [PERFORMANCE.md](./PERFORMANCE.md).

## Upgrading from v1

v2 requires a new `candidates` table (see the schema above) and the new `candidateTableName` option. The candidate table is what makes head selection independent of document arrival order (see [`FORK-TRACKING-PLAN.md`](./FORK-TRACKING-PLAN.md) for the design background); earlier versions could index a stale or order-dependent head when device clocks were skewed or `updatedAt` values tied. Existing databases must be re-indexed after upgrading: create the new table, call `indexer.deleteAll()`, and re-index all documents from their source.

## Maintainers

[@digidem](https://github.com/digidem)

## Contributing

PRs accepted.

Small note: If editing the README, please conform to the [standard-readme](https://github.com/RichardLitt/standard-readme) specification.

## License

MIT © 2025 Awana Digital
