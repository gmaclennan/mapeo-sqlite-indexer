# Performance notes

Findings from profiling and benchmarking the indexer (July 2026), using
`bench.js` (see its header for the workload scenarios). Numbers below are
from a 4-core Linux container; treat them as directional (run-to-run noise
was ±10%) and re-measure on target hardware (e.g. Android) for
decision-grade numbers.

## Where time goes

CPU profiles (`node --cpu-prof bench.js`) on Node 18 and Node 24 show the
same shape:

- ~25% in better-sqlite3's transaction wrapper (BEGIN/COMMIT per
  `batch()` call)
- ~35–40% in the four per-document statement calls (get existing doc,
  write backlinks, check linked-ness, write doc)
- ~10% garbage collection

With a file-backed WAL database the same workload runs 5–8× slower than
with an in-memory database: **commit and page I/O dominates real-world
indexing time**, so JS-level optimisations mostly move the in-memory
(CPU-bound) numbers. The biggest real-world lever is application-level:
larger batches amortise per-transaction commit I/O.

## What was done

- `.raw()` rows, positional bindings, a pluck'd `EXISTS` for the
  linked-ness check, and removal of per-doc object spreads/allocations in
  the hot path (in `index.js`). Worth roughly 10% on CPU-bound runs, less
  file-backed.
- Upgrade to better-sqlite3 v13 (N-API): performance parity with v11 on
  this workload — all differences were within noise. Node 18 vs Node 24
  was also mostly a wash (Node 24 faster on create/fork-style workloads,
  slightly slower on edit-style).

## Set-based batching: measured and rejected

Two prototype rewrites of `batch()` were measured against the current
per-document implementation (both pass the full test suite via
`INDEXER_IMPL=../index-<name>.js npx borp`):

- **`index-batched.js`** — fully set-based: a fixed number of chunked
  statements per batch (`IN`-list SELECTs, multi-row INSERT/REPLACE),
  head-selection in memory.
- **`index-hybrid.js`** — keeps per-document point reads, but coalesces
  writes: evolving heads are tracked in memory and flushed once per batch
  with multi-row statements.

Speedups vs current implementation (docs/sec, best of 4 interleaved
rounds, Node 24 / better-sqlite3 v13, batch size 100):

| scenario | batched (memory) | hybrid (memory) | hybrid (file WAL) |
| -------- | ---------------- | --------------- | ----------------- |
| create   | 0.98x            | 0.90x           | 0.89x             |
| edit     | 0.93x            | 0.92x           | 0.89x             |
| fork     | 1.24x            | 1.58x           | 1.08x             |
| sync     | 0.68x            | 0.96x           | 0.93x             |

The fully set-based version was also catastrophically slower for small
batches (0.06x at batch size 1, from `IN`-list padding overhead).

Interpretation: better-sqlite3's per-statement overhead is already tiny,
and SQLite point lookups on a `WITHOUT ROWID` primary key are as fast as
`IN`-list queries (which pay to build an ephemeral index per query).
Batching reads therefore loses; coalescing writes only wins when a batch
contains several versions of the same document (the fork scenario), and
costs ~10% everywhere else from the extra bookkeeping. On file-backed
databases — the real deployment target — everything shrinks toward the
noise floor because commit I/O dominates.

**Conclusion: the per-document design in `index.js` is the right one.**
The prototypes are kept in the repo for reference and can be re-measured
with `INDEXER_IMPL` if circumstances change (e.g. a different storage
backend or much larger batches of same-document versions).

Equivalence caveat: `index-hybrid.js` is observably equivalent to
`index.js`. `index-batched.js` is equivalent only when timestamps are
causally monotonic — because it computes linked-ness for the whole batch
up-front, it can pick a different (arguably more `getWinner`-consistent)
head than `index.js` under clock skew or tied timestamps. See
`test/winner-staleness.test.js` for the related order-dependence
limitation of `index.js` itself.
