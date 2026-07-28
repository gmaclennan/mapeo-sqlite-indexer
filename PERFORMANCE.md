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
  the hot path (in `index.js`). Worth roughly 10% on CPU-bound runs.
  Measured in isolation on **disk-backed** WAL databases (A/B against an
  otherwise-identical build with only these changes reverted, interleaved
  rounds, median docs/sec): at batch size 100 the effect is within the
  container's noise floor (create +9%, edit +2%, fork −5%, sync −4%); at
  batch size 1000, where commit I/O is amortised and per-doc CPU matters
  more, gains are consistent (create +3%, edit +18%, fork +3%, sync +5%).
  Net: neutral-to-positive on disk, growing with batch size.
- Upgrade to better-sqlite3 v13 (N-API): performance parity with v11 on
  this workload — all differences were within noise. Node 18 vs Node 24
  was also mostly a wash (Node 24 faster on create/fork-style workloads,
  slightly slower on edit-style).

## Set-based batching: measured and rejected

Two prototype rewrites of `batch()` were built, verified against the full
test suite, and measured against the current per-document implementation.
Both were rejected and have since been removed from the repo (they remain
available in the git history of the branch that produced these numbers):

- **"batched"** — fully set-based: a fixed number of chunked statements
  per batch (`IN`-list SELECTs, multi-row INSERT/REPLACE), head-selection
  in memory.
- **"hybrid"** — keeps per-document point reads, but coalesces writes:
  evolving heads are tracked in memory and flushed once per batch with
  multi-row statements.

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
A further mark against the fully set-based approach: it was not
semantically equivalent to `index.js` under clock skew or tied timestamps
(computing linked-ness for the whole batch up-front can pick a different
head — see `test/winner-staleness.test.js` for the related
order-dependence limitation of `index.js` itself).

For future experiments, `test/utils.js` and `bench.js` still accept an
`INDEXER_IMPL` env var pointing at an alternative implementation, so a
candidate rewrite can be validated against the full test suite and
benchmarked without touching `index.js`.
