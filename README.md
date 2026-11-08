# Argia

![Argia](assets/logo.png)

Argia moves a RAG index from one embedding model to another while it stays
live. You give it two profiles, each an embedding model plus the vector store
that holds its vectors. Writes go to both (until the last phase), reads go to
whichever one the current phase says, and you move the phase forward or back
with `setPhase`.

No runtime dependencies. ESM only. Node 24+ (CI runs 24 and 26 on Linux,
macOS and Windows).

## Quick start

1. Install: `npm install argia-migrator`.
2. Describe both profiles and choose the failure policy. `openaiEmbed`,
   `cohereEmbed`, `pgvectorStore` and `metrics` stand for your own code:

```ts
import { Migration, overlap, type Profile } from "argia-migrator";

type Meta = { source: string };
type Filter = { source?: string };

const from: Profile<Meta, Filter> = {
	name: "text-embedding-3-small",
	dimensions: 1536,
	embed: (texts) => openaiEmbed(texts),
	store: pgvectorStore("chunks_v1"),
};

const to: Profile<Meta, Filter> = {
	name: "embed-v4",
	dimensions: 1024,
	embed: (texts) => cohereEmbed(texts),
	store: pgvectorStore("chunks_v2"),
};

const migration = new Migration({
	from,
	to,
	phase: "from",
	shadowWriteFailure: "report",
	compareRate: 0.1,
	onEvent: (event) => {
		if (event.type === "compare") {
			const { recall, rankOverlap } = overlap(event.from, event.to);
			metrics.observe("argia.recall", recall);
			metrics.observe("argia.rank_overlap", rankOverlap);
		}
	},
});
```

`overlap` compares ids and ranks, never scores. It returns:

- `recall`: the share of today's hits that the new index also returns.
- `rankOverlap`: rank-biased overlap, which weights agreement at the top
  more than agreement at the bottom.
- `topMatch` and `shared`.

One way to decide: wait until the median `recall` stays above a level you
pick over a week of real traffic, then read a sample of the queries where it
is lowest. The new model can disagree with the old one and be right.

3. Route your ingestion and retrieval through it (`row`, `chunk` and
   `question` come from your own code):

```ts
await migration.write([{ id: "doc-1#0", version: row.updatedAt, text: chunk, metadata: { source: "doc-1" } }]);
const hits = await migration.query(question, 8, { source: "doc-1" });
```

4. Fill the new index from your source documents with
   `migration.backfill(batch)`, while live writes keep going through `write`.
   The higher version wins, so a backfill row older than a live write is
   ignored.
5. `migration.setPhase("compare")`, watch the events, then `"to"`, then
   `"to-only"` once you no longer want the way back.

A store adapter is three methods (`upsert`, `query`, `delete`), plus an
optional `versions` for `diff`; see
`VectorStore` in the API docs. Each profile needs its own store object,
pointing at its own table, index or collection.

Both writes must be conditional on version, atomically: replace when the
stored version is not higher, and keep deletes as tombstones that the same
rule applies to. In Postgres that is `INSERT ... ON CONFLICT (id) DO UPDATE
... WHERE stored.version <= excluded.version`, with a `deleted` flag that
queries skip. An adapter that writes unconditionally brings back both races
the version exists to stop.

Argia does not touch your database, so it cannot see whether your adapter
does this. `argia-migrator/conformance` checks it. Run it in your own
tests against an empty scratch table or collection:

```ts
import { checkVectorStore } from "argia-migrator/conformance";

await checkVectorStore({
	store: pgvectorStore("argia_scratch"),
	dimensions: 1024,
	idPrefix: "argia-check",
	metadata: (label) => ({ source: label }),
});
```

`tests/integration/pgvector.ts` is a complete adapter for Postgres with
pgvector that passes this check. It is a test fixture, not part of the
package; copy it and change the table and filter to fit.

It writes stale, equal, concurrent and deleted versions, then queries them
back, and throws `nonconformant_store` with one line per broken rule. The
store must return each point's metadata unchanged in its hits; that is how
the check tells which copy was kept. It leaves its rows and tombstones
behind.

## Not included

- Copying vectors between databases without re-embedding. Use your
  databases' export and import tools.
- A phase shared across replicas. Each `Migration` holds its own; see
  [Running more than one replica](#running-more-than-one-replica).
- Retries and timeouts on `embed` and store calls. Wrap them with
  `firefly-limiter` or `p-retry`.
- Store adapters, and deciding when the new index is ready. `overlap` gives
  you numbers; the threshold is yours.

## How it works

The phase decides where each call goes:

| phase     | writes go to | queries read | other side queried |
| --------- | ------------ | ------------ | ------------------ |
| `from`    | from, to     | from         | no                 |
| `compare` | from, to     | from         | at `compareRate`   |
| `to`      | from, to     | to           | no                 |
| `to-only` | to           | to           | no                 |

- `to` still writes to the old store, so moving back to `from` or `compare`
  loses nothing. `to-only` stops writing to the old store; after that,
  going back means re-ingesting.
- The side being read is the primary, and it is written first. If its write
  fails, the call throws your error unchanged and the other side is never
  touched, whatever `shadowWriteFailure` says.
- The other side is the shadow. `shadowWriteFailure: "throw"` rethrows its
  failures; `"report"` emits `shadow_write_failed` and lets the call succeed.
  There is no default: only you know whether a broken new index may stop
  ingestion.
- In `compare`, `compareRate` (0 to 1, required) decides what share of
  queries also run against the other side. Each compared query reports both
  hit lists, scores included, through `onEvent`.
- `backfill` embeds and writes to the `to` profile only, in any phase, so
  filling the new index does not re-embed everything the old one holds.
- `writeOrder: "parallel"` (optional) starts both writes at once instead of
  read side first. A dual write then takes as long as the slower store. A
  write the read side refused may still land on the shadow; the call throws
  and your retry rewrites the same version, so the stores end up equal.
- `diff(ids)` asks both stores what they hold for each id and returns the
  ones that disagree. It is how you find what `shadowWriteFailure: "report"`
  left behind; see [Finding and repairing gaps](#finding-and-repairing-gaps).
- `query(text, k, filter)` hands `filter` to your store adapter untouched, on
  both sides when compared.
- Every document and delete carries a `version`, and a store keeps the
  higher one. A backfill of an old copy, or a slow writer, cannot overwrite
  a newer write, and a write older than a delete cannot bring the document
  back. Use a revision counter or the source row's last-modified time.
- Every vector is checked: the count must match the texts, the length must
  match the profile's `dimensions`, and every value must be finite. Every
  query result is checked too: an array of at most `k` hits, each with a
  non-empty string id and a finite score.
- A listener that throws, or an async listener that rejects, is ignored.
  Async listeners are not awaited.

## Finding and repairing gaps

With `shadowWriteFailure: "report"`, a failed shadow write leaves the
shadow store missing documents until they are written again. To find them,
give your adapter an optional fourth method, `versions(ids)`. It returns,
for each id in order, `{ version, deleted }` or `null` if the store has
never seen it. Then walk your source ids in batches:

```ts
for await (const ids of sourceIdBatches(500)) {
	const drift = await migration.diff(ids);
	if (drift.length > 0) {
		// Re-read from the source, which is the truth, and write again.
		// The version rule makes rewriting an up-to-date copy harmless.
		await migration.write(await loadDocuments(drift.map((d) => d.id)));
	}
}
```

Each entry says what each side holds, so you can tell a missing document
(`to: null`) from a stale one (`to.version` lower) or a delete that did not
land (`from.deleted !== to.deleted`). Documents deleted at the source show
up the same way, so send those to `migration.delete` instead.

`diff` is a snapshot. A write that runs at the same moment can show up as
drift and be gone a second later, so check again before acting on a short
list. Run it before leaving `to` for `to-only`. After `to-only` the old
store stops receiving writes, so drift there is expected.

The conformance check also tests `versions` when your adapter has it, and
the pgvector fixture implements it.

## Running more than one replica

Argia has no shared phase, but `setPhase` is a plain method, so you can
drive it from a feature flag, a config service or a database row. Each
replica reads the shared value before constructing `Migration` (pass it as
`phase`), then polls or subscribes and calls `setPhase` when it changes.

Propagation is never atomic. Replicas learn about a change at different
times, depending on the poll interval, pub/sub lag and requests already in
flight. A shared store shrinks that window but does not close it. Only one
transition is dangerous:

- `from`, `compare` and `to` all write to both stores, so replicas can move
  between them in any order. While replicas disagree, they read from
  different sides, but both sides stay current.
- `to-only` is the risky one. Once one replica stops writing to the old store,
  any replica still reading from it serves stale results.

So:

1. Leave every replica in `to` for longer than your worst-case propagation
   time (poll interval plus the longest in-flight request) before any
   replica enters `to-only`. For more certainty, have each replica report
   its `migration.phase` (a heartbeat or a metric), and only switch to
   `to-only` once all of them show `to`.
2. If the shared store is unreachable at startup, fall back to a phase that
   writes to both sides, never `to-only`.
3. If it goes down while running, keep the last known phase rather than
   resetting it.
4. Validate the value before calling `setPhase`. An unknown phase throws.

You can also skip `to-only`. `to` already reads from the new index and
keeps the old one written. All `to-only` saves you is the second write and
its embedding cost. If that cost is tolerable, stay in `to` and retire the
old store with an ordinary deploy that removes the `from` profile.

## Compare events and sensitive queries

`compare` and `shadow_query_failed` events carry the query text. If your
queries can contain personal or confidential data, your listener and
whatever it logs to will see that text. Pass `redactText` to rewrite it
first. For example, return `""` to drop it, or a hash to group repeats:

```ts
import { createHash } from "node:crypto";

redactText: (text) => createHash("sha256").update(text).digest("hex").slice(0, 16),
```

If `redactText` throws, the event is dropped, not sent with the raw text.

## Where it sits

We found no other library that does this job, though we have not searched
exhaustively. The closest things:

- [Qdrant's migration tutorial](https://qdrant.tech/documentation/tutorials-operations/embedding-model-migration/)
  lays out the same steps by hand for Qdrant: a second collection, dual
  writes, a background re-embed, then an alias switch.
- Copy tools such as the Qdrant migration tool, `cyborgdb-migrate` and
  `velesdb-migrate` move existing vectors into one fixed destination
  database. They do not re-embed or route live traffic.
- LangChain's indexing API and its record manager keep one vector store in
  step with a source by skipping unchanged documents and cleaning up stale
  ones. It indexes into one store, not two models side by side.

## Known quirks

- By default the two writes run one after the other, so a dual write takes
  as long as both together. That ordering is what keeps a refused write out
  of the shadow store. `writeOrder: "parallel"` drops that for lower
  latency.
- If the primary write succeeds and the shadow write fails, the shadow store
  misses those documents until they are written again, which is why upserts
  must be idempotent. `diff` finds them.
- A compared query waits for both stores, so it takes as long as the slower
  one. `compareRate` limits how many queries pay that.
- Tombstones pile up. Purging them is your adapter's job; purge one only once
  no write older than it can still arrive.
- Argia cannot see your other replicas. Move every replica to `to` before any
  goes to `to-only`, or a replica still reading the old store misses the
  writes the `to-only` ones stopped sending it. See
  [Running more than one replica](#running-more-than-one-replica).
- Scores from two different models are not on one scale; compare ids and
  ranks, not raw scores.
- `embed` receives every text of a `write` or `backfill` call at once. Split
  the call yourself if your provider caps the batch.
- No benchmarks yet.

## Licence

ISC.

## Lore

Argia are the dancer damselflies. They spend their larval life underwater and
their adult life in the air, and the move from one to the other happens in the
final molt, on a reed stem. The old skin stays clinging to the reed for a
while afterwards, which is the `to` phase.
