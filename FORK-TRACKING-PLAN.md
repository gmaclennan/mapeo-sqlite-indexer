# Plan: fixing the fork-tracking design limitations

This is a plan to fix the two known correctness limitations of the indexer,
documented as `todo` tests in `test/winner-staleness.test.js` and found by
property-based testing (`test/convergence-fuzz.test.js` covers the regime
that works; randomised testing of the regimes below found the failures).

## The problem, in one sentence

The index stores only the winning head's full document per `docId` — forks
are stored as bare versionId strings — so once a version loses `getWinner`
it can never be re-compared or promoted, even when later documents prove it
should be the head.

## When does this matter?

Only when `getWinner`'s ordering disagrees with causal order, i.e. when an
_edit_ of a document compares as "older" than a version it supersedes. That
happens in two realistic situations:

1. **Device clock skew**: an edit written on a device with a slow clock has
   an `updatedAt` earlier than versions it causally follows. Mapeo runs on
   offline devices where wrong clocks are common.
2. **Tied `updatedAt` values**: the tie-break compares versionIds, which
   are random — so for two concurrent versions the "winner" is a coin flip
   with respect to causal order.

Property-based testing shows that when every edit's `updatedAt` is newer
than its parent's, indexing is fully order-independent (0 failures in 3000
randomised deliveries). Both failure modes below need one of the two
situations above.

## Failure mode 1: a stale head that is never replaced

Three versions of one document, where C was written on a device with a
slow clock (t1 < t2 < t3):

```
A (root, updatedAt: t2) ← B (links: [A], t3) ← C (links: [B], t1)
```

C is the newest version causally: A and B are both superseded. Now deliver
them in the order **A, C, B** (out-of-order arrival is normal during sync):

1. `A` arrives → head is A.
2. `C` arrives. Its parent B is unknown, so C is an unlinked candidate.
   `getWinner(A, C)` compares timestamps: t2 > t1, so **A stays head** and
   C is recorded in `forks` — as the _string_ `"C"`.
3. `B` arrives. It is already linked (C links it), and it links A — so A
   is now superseded too. The only unlinked version, i.e. the true head,
   is C. But all the index has for C is the string `"C"` — its document
   was never stored — so **A stays head forever**, even though A is a
   version somebody has edited. Every query returns stale content until
   some future edit happens to displace A.

## Failure mode 2: different arrival orders, different heads

Four versions, where Y is an edit written on a slow-clock device
(t1 < t2 < t3):

```
A (root, t1) ← B (links: [A], t3) ← Y (links: [B], t1)
             ← F (links: [A], t2)          (F is a concurrent fork)
```

The unlinked versions at the end are F and Y in every order. But:

- Order **A, B, F, Y**: F loses `getWinner(B, F)` and becomes a fork of
  head B. Then Y arrives, B is now linked, so Y replaces B and _inherits_
  fork F — `getWinner(Y, F)` is never called. Result: **head Y, forks [F]**.
- Order **A, B, Y, F**: Y replaces the linked B first. Then F arrives and
  competes: `getWinner(Y, F)` picks F (t2 > t1). Result: **head F,
  forks [Y]**.

Two devices that sync the same data in different orders end up with
different indexed heads — they never converge. (The same happens with tied
timestamps and unlucky random versionIds.)

Both modes share the root cause: the winner can only ever be computed
between the incoming doc and the stored head, never against forks, because
fork documents are not stored.

## What a fix must provide

Whenever the set of _unlinked versions_ (head candidates) of a `docId`
changes, the indexer must recompute
`head = winner over all current candidates` — which requires the **full
document of every candidate**, not just its versionId. With the default
`getWinner` (a deterministic total order), "winner over the whole
candidate set" is simply its maximum, which is independent of arrival
order — this fixes both failure modes at once, provably.

## Options

### Option A: store full docs in the `forks` column

Change `forks` from a JSON array of versionIds to a JSON array of full
document objects.

- ✅ Fixes both modes; no new tables.
- ❌ **Breaking for every consumer that reads `forks`** (format change).
- ❌ Bloats the hot `docs` row; extra columns must be captured per fork.

### Option B (recommended): an internal "candidates" table

Add one internal table alongside `backlinks`, holding the full document of
every currently-unlinked version:

```sql
CREATE TABLE candidates (
  versionId TEXT PRIMARY KEY NOT NULL,
  docId TEXT NOT NULL,        -- indexed, for per-document lookup
  doc TEXT NOT NULL           -- full document as JSON
) WITHOUT ROWID
```

Per document in a batch: write backlinks (unchanged), delete candidates
that became linked, insert the incoming doc if unlinked, then recompute
the winner over the docId's candidates and write the `docs` row as today
(`forks` = the other candidates' versionIds — **format unchanged**).

- ✅ Fixes both modes; convergence is provable for any deterministic
  total-order `getWinner`.
- ✅ `docs` table schema and `forks` format unchanged — queries and
  downstream consumers (e.g. comapeo-core) are unaffected.
- ✅ Storage cost proportional to _unresolved forks only_ (candidates for
  a doc with no forks = just the head), and rows are deleted as forks
  resolve.
- ❌ Consumers must create one more table (same setup pattern as
  `backlinks`; validated by `assertValidSchema`) → major version bump.
- ❌ ~1 extra point-SELECT per indexed doc and 1 insert/delete per head
  change: expect single-digit % slowdown (to be measured, see Phase 1).
- Migration: existing databases must be re-indexed (`deleteAll()` +
  re-batch from source). Mapeo indexes are already rebuildable from the
  underlying hypercores, so no data migration is needed.

### Option C: ask the application for missing docs (callback)

Keep storage as-is; when the indexer needs a fork's document, call an
application-supplied `getDoc(versionId)` callback.

- ❌ Couples the indexer to the caller's storage; the caller's lookup is
  typically async while `batch()` is synchronous — a much bigger API
  break than Option B for no storage saving in practice.

## Recommended plan (Option B)

1. **Prototype and verify** (no API change yet): implement
   `index-candidates.js` behind the existing `INDEXER_IMPL` switch
   (candidates table created internally by the prototype). Acceptance
   criteria:
   - The full 43-test suite passes.
   - The two `todo` tests in `test/winner-staleness.test.js` pass.
   - The convergence fuzz test passes with skewed and tied clocks
     (extend `test/convergence-fuzz.test.js` to all three clock modes for
     this implementation — currently only the monotonic mode is asserted).
   - `npm run bench` regression is within an agreed budget (suggest:
     ≤10% on file-backed scenarios).
2. **Decide** on the measured numbers whether to promote.
3. **Promote**: fold into `index.js`, require the `candidates` table in
   `assertValidSchema`, document setup + reindex-on-upgrade in the README
   and CHANGELOG, release as a **major version**. Coordinate the
   downstream comapeo-core update (add table creation + one-time reindex).
4. **Harden**: make the previously-`todo` tests regular tests, run the
   convergence fuzz in all clock modes in CI, and delete the two rejected
   performance prototypes (`index-batched.js`, `index-hybrid.js`) to keep
   maintenance surface small.

Open questions to settle before Phase 3:

- Is the `getWinner` option's contract "deterministic total order"
  acceptable to document as a hard requirement? (The default already is
  one; convergence cannot be guaranteed for arbitrary custom functions.)
- Should candidate rows store only the fields `getWinner`/`writeDoc` need
  (smaller rows, but breaks custom `getWinner` functions that read other
  fields) or the full document (recommended: full document)?
