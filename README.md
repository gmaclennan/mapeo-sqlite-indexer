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

For maximum performance, activate [Write-Ahead Logging](https://sqlite.org/wal.html) and create the tables [`WITHOUT ROWID`](https://sqlite.org/withoutrowid.html).

## Table of Contents

- [Install](#install)
- [Usage](#usage)
- [API](#api)
- [Benchmarks](#benchmarks)
- [Known limitations](#known-limitations)
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

The constructor checks that the tables named by `opts.docTableName` and `opts.backlinkTableName` exist and have the required columns (see above), and throws if they do not.

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

#### opts.getWinner

_Optional_\
Type: `(docA, docB) => docA | docB`

Function used to determine the "winning" version when a document is forked. It is called with two documents and must return one of them. By default the version with the later `updatedAt` value wins, with ties broken by choosing the higher `versionId` (comparing strings), so that the winner is deterministic. A custom `getWinner` should likewise implement a deterministic total order over versions, so that the same winner is chosen whatever order documents are indexed in.

### indexer.batch(docs)

Index an array of documents (runs in a single SQLite transaction). Documents can be in any order — parents may arrive before or after their children. Each document must have a `docId` property, a `versionId` property that is unique, a `links` property which is an array of the `versionId`s of the document's parent(s), and an `updatedAt` property.

Additional properties are stored in the SQLite table if a column with a matching name exists (properties without a matching column are ignored). Values are stored as follows:

- `links` and `forks` are stored as JSON-encoded arrays, e.g. `'["2","3"]'`.
- Booleans are stored as `1` or `0`.
- Objects and arrays in extra columns are stored JSON-stringified.
- Missing (`undefined`) or `null` values are stored as the column's SQL `DEFAULT` value (or `NULL` if the column has no default).

The document stored in SQLite will have a `forks` column which is a JSON-encoded array of the `versionId`s of other forks of the document, if any exist (an empty array `'[]'` otherwise).

### indexer.deleteAll()

Delete all documents and backlinks. Useful if you want to reset the index.

## Benchmarks

Run `npm run bench` to benchmark the indexer across several realistic scenarios (initial creates, linear edits, forks, and out-of-order sync) — see the header of [`bench.js`](./bench.js) for options. Findings from profiling and benchmarking are written up in [PERFORMANCE.md](./PERFORMANCE.md).

## Known limitations

Forks are stored as bare `versionId`s, so the indexer can never re-run `getWinner` against a fork after the fact. If device clocks are skewed (a causally-newer version has an older `updatedAt`) or `updatedAt` values tie across a fork, the indexed head can depend on the order in which documents arrive, and a head that is later superseded may not be replaced. Indexing is fully order-independent when each edit's `updatedAt` is newer than its parent's, which holds in practice when device clocks are roughly in sync. See [`test/winner-staleness.test.js`](./test/winner-staleness.test.js) for details, and [`FORK-TRACKING-PLAN.md`](./FORK-TRACKING-PLAN.md) for a plan to fix this.

## Maintainers

[@digidem](https://github.com/digidem)

## Contributing

PRs accepted.

Small note: If editing the README, please conform to the [standard-readme](https://github.com/RichardLitt/standard-readme) specification.

## License

MIT © 2025 Awana Digital
