# Argia

![Argia](assets/logo.png)

**Argia is for RAG projects changing embedding models without a flag day.**

You give it two profiles, each an embedding model plus the vector store that
holds its vectors. Writes go to both; reads go to whichever one the current
phase says. You move the phase when you are satisfied the new index is good,
and you can move it back. Argia does not copy existing vectors between
databases, ship store adapters, or decide when you are ready.

Zero runtime dependencies. ESM only. Nothing runs on import, nothing is
logged, no environment variables are read.

## Argia is not for you if you

- want to copy vectors from one database to another without re-embedding.
  Argia always embeds with each profile's own model; a byte copy is a job for
  your databases' export and import tools.
- need the phase shared across a fleet. The phase lives in one `Migration`
  object in one process. Twenty replicas are twenty phases, and moving them
  together is your deploy's job (an environment variable read by your code,
  a config push).
- want retries or timeouts on embedding or store calls. Wrap your `embed` and
  store methods with Firefly Limiter (`firefly-limiter`), or outside
  Smiduweorc with `cockatiel` (retries, breakers, timeouts, bulkheads),
  `p-retry` for retries alone, or `opossum` for a circuit breaker.
- want a recall score computed for you. The `compare` phase hands you both hit
  lists; which metric means "ready" is yours.

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
  There is no default, because whether a broken new index may stop ingestion
  is your call.
- In `compare`, `compareRate` (0 to 1, required) decides what share of
  queries also run against the other side. Each compared query reports both
  hit lists, scores included, through `onEvent`.
- `backfill` embeds and writes to the `to` profile only, in any phase, so
  filling the new index does not re-embed everything the old one holds.
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

## Quick start

1. Install: `npm install argia-migrator`. Node 22 or later, ESM only.
2. Describe both profiles and choose the failure policy. `openaiEmbed`,
   `cohereEmbed`, `pgvectorStore` and `metrics` stand for your own code:

```ts
import { Migration, type Profile } from "argia-migrator";

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
			const before = new Set(event.from.map((hit) => hit.id));
			const overlap = event.to.filter((hit) => before.has(hit.id)).length;
			metrics.observe("argia.overlap", overlap / event.k);
		}
	},
});
```

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

A store adapter is three methods (`upsert`, `query`, `delete`); see
`VectorStore` in the API docs. Each profile needs its own store object,
pointing at its own table, index or collection.

Both writes must be conditional on version, atomically: replace when the
stored version is not higher, and keep deletes as tombstones that the same
rule applies to. In Postgres that is `INSERT ... ON CONFLICT (id) DO UPDATE
... WHERE stored.version <= excluded.version`, with a `deleted` flag that
queries skip. An adapter that writes unconditionally brings back both races
the version exists to stop.

Argia does not touch your database, so it cannot see whether your adapter
does this. `argia-migrator/conformance` checks it for you. Run it in your own
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

## Where it sits

No other library does this job, as far as we could find. The pattern is
written up as a procedure, and Argia is that procedure turned into code
that runs against any store.

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

- The two writes run one after the other, so a dual write takes as long as
  both together. That ordering is what keeps a refused write out of the
  shadow store.
- If the primary write succeeds and the shadow write fails, the shadow store
  misses those documents until they are written again, which is why upserts
  must be idempotent.
- A compared query waits for both stores, so it takes as long as the slower
  one. `compareRate` limits how many queries pay that.
- Tombstones pile up. Purging them is your adapter's job; purge one only once
  no write older than it can still arrive.
- Argia cannot see your other replicas. Move every replica to `to` before any
  goes to `to-only`, or a replica still reading the old store misses the
  writes the `to-only` ones stopped sending it.
- Scores from two different models are not on one scale; compare ids and
  ranks, not raw scores.
- `embed` receives every text of a `write` or `backfill` call at once. Split
  the call yourself if your provider caps the batch.
- No benchmarks yet.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run build` | Compile to `dist/` with type declarations. |
| `npm run typecheck` | Type-check the source and the tests, including the compile-fail fixtures in `tests/types/`. |
| `npm run lint` | Run ESLint. |
| `npm test` | Run the suite against the source. |
| `npm run test:dist` | Build, then test the built package through its own name. |
| `npm run test:pg` | Run the pgvector adapter, the conformance check and a full migration against Postgres at `ARGIA_PG_URL`. |
| `npm run docs` | Generate the API docs into `docs/`. |
| `npm run changelog` | Regenerate `CHANGELOG.md` with git-cliff. |

For `test:pg`, start pgvector and point the tests at it:

```sh
docker run -d --name argia-pg -e POSTGRES_PASSWORD=argia -p 54329:5432 pgvector/pgvector:pg17
ARGIA_PG_URL=postgres://postgres:argia@localhost:54329/postgres npm run test:pg
```

Publishing is manual; `./release.sh vX.Y.Z` bumps, writes the changelog and
tags.

## Licence

ISC.

## Lore

Argia are the dancer damselflies. They spend their larval life underwater and
their adult life in the air, and the move from one to the other happens in a
single molt on a reed stem. The old skin stays clinging to the reed for a
while afterwards, which is the `to` phase.


