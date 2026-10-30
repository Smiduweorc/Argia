import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

import { Migration, type MigrationEvent, type Profile } from "../../index.js";
import { checkVectorStore } from "../../conformance.js";
import { pgvectorStore, type Filter, type Meta } from "./pgvector.js";

// Integration tests read their database from the environment; the library never does.
const url = process.env["ARGIA_PG_URL"];
if (url === undefined) {
	throw new Error("ARGIA_PG_URL is not set; start pgvector (see README, Scripts) and export it");
}

const pool = new pg.Pool({ connectionString: url, max: 10 });
const tables: string[] = [];

async function freshTable(name: string, dimensions: number): Promise<Awaited<ReturnType<typeof pgvectorStore>>> {
	const table = `argia_${name}_${process.pid}`;
	tables.push(table);
	await pool.query(`DROP TABLE IF EXISTS ${table}`);
	return pgvectorStore(pool, table, dimensions);
}

// Deterministic stand-ins for two models: the vectors differ in length and content, which is all Argia can tell apart.
const model = (dimensions: number, seed: number) => async (texts: string[]): Promise<number[][]> =>
	texts.map((text) => Array.from({ length: dimensions }, (_, i) =>
		[...text].reduce((sum, ch) => sum + ch.charCodeAt(0) * (i + seed), 1) % 97 + 1));

async function rows(table: string): Promise<{ id: string; version: number; deleted: boolean; text: string | null }[]> {
	return (await pool.query(`SELECT id, version, deleted, text FROM ${table} ORDER BY id`)).rows;
}

before(async () => {
	await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
});

after(async () => {
	for (const table of tables) await pool.query(`DROP TABLE IF EXISTS ${table}`);
	await pool.end();
});

test("the pgvector reference adapter passes the conformance check", async () => {
	await checkVectorStore({ store: await freshTable("conformance", 3), dimensions: 3, idPrefix: "argia-check", metadata: (label) => ({ source: label }) });
});

test("the conformance check catches an unconditional upsert against real Postgres", async () => {
	const store = await freshTable("unconditional", 3);
	const table = tables.at(-1) as string;
	store.upsert = async (points) => {
		for (const p of points) {
			await pool.query(`INSERT INTO ${table} (id, version, deleted, text, metadata, embedding) VALUES ($1, $2, false, $3, $4, $5::vector)
				ON CONFLICT (id) DO UPDATE SET version = excluded.version, deleted = false, metadata = excluded.metadata, embedding = excluded.embedding`,
			[p.id, p.version, p.text, JSON.stringify(p.metadata), `[${p.vector.join(",")}]`]);
		}
	};
	await assert.rejects(checkVectorStore({ store, dimensions: 3, idPrefix: "argia-check", metadata: (label) => ({ source: label }) }),
		(error) => error instanceof Error && "code" in error && error.code === "nonconformant_store");
});

test("a migration from one table and model to another runs through every phase against Postgres", async () => {
	const from: Profile<Meta, Filter> = { name: "model-a", dimensions: 3, embed: model(3, 1), store: await freshTable("from", 3) };
	const to: Profile<Meta, Filter> = { name: "model-b", dimensions: 4, embed: model(4, 7), store: await freshTable("to", 4) };
	const [fromTable, toTable] = tables.slice(-2) as [string, string];
	const events: MigrationEvent<Meta>[] = [];
	const migration = new Migration({ from, to, phase: "from", shadowWriteFailure: "throw", compareRate: 1, onEvent: (e) => events.push(e) });

	await migration.write([
		{ id: "doc-1", version: 10, text: "ants carry leaves", metadata: { source: "wiki" } },
		{ id: "doc-2", version: 10, text: "bees make honey", metadata: { source: "blog" } },
	]);
	// A backfill that read doc-1 before its latest edit must not overwrite it.
	await migration.backfill([
		{ id: "doc-1", version: 9, text: "ants (old copy)", metadata: { source: "wiki" } },
		{ id: "doc-3", version: 5, text: "wasps build paper nests", metadata: { source: "wiki" } },
	]);
	assert.deepEqual((await rows(toTable)).map((r) => [r.id, r.version, r.text]), [
		["doc-1", 10, "ants carry leaves"], ["doc-2", 10, "bees make honey"], ["doc-3", 5, "wasps build paper nests"],
	]);
	assert.deepEqual((await rows(fromTable)).map((r) => r.id), ["doc-1", "doc-2"]);

	migration.setPhase("compare");
	const hits = await migration.query("ants", 5, { source: "wiki" });
	assert.deepEqual(hits.map((h) => h.id), ["doc-1"]);
	assert.equal(events.length, 1);
	const compared = events[0] as Extract<MigrationEvent<Meta>, { type: "compare" }>;
	assert.deepEqual(compared.from.map((h) => h.id), ["doc-1"]);
	assert.deepEqual(compared.to.map((h) => h.id).sort(), ["doc-1", "doc-3"]);
	assert.ok(compared.to.every((h) => h.metadata?.source === "wiki"));

	migration.setPhase("to");
	await migration.delete([{ id: "doc-2", version: 11 }]);
	assert.deepEqual((await migration.query("bees", 5)).map((h) => h.id).sort(), ["doc-1", "doc-3"]);
	assert.equal((await rows(fromTable)).find((r) => r.id === "doc-2")?.deleted, true);
	// The late copy of doc-2 is older than its delete and stays dead in both tables.
	await migration.write([{ id: "doc-2", version: 10, text: "bees (late)", metadata: { source: "blog" } }]);
	assert.equal((await rows(toTable)).find((r) => r.id === "doc-2")?.deleted, true);
	assert.equal((await rows(fromTable)).find((r) => r.id === "doc-2")?.deleted, true);

	migration.setPhase("to-only");
	await migration.write([{ id: "doc-4", version: 1, text: "termites farm fungus", metadata: { source: "wiki" } }]);
	assert.deepEqual((await rows(toTable)).map((r) => r.id), ["doc-1", "doc-2", "doc-3", "doc-4"]);
	assert.deepEqual((await rows(fromTable)).map((r) => r.id), ["doc-1", "doc-2"]);
});

test("concurrent writers on one id leave both Postgres tables at the highest version", async () => {
	const from: Profile<Meta, Filter> = { name: "model-a", dimensions: 3, embed: model(3, 1), store: await freshTable("race_from", 3) };
	const to: Profile<Meta, Filter> = { name: "model-b", dimensions: 4, embed: model(4, 7), store: await freshTable("race_to", 4) };
	const [fromTable, toTable] = tables.slice(-2) as [string, string];
	const migration = new Migration({ from, to, phase: "from", shadowWriteFailure: "throw", compareRate: 0 });
	const versions = Array.from({ length: 30 }, (_, i) => (i * 17) % 30);
	await Promise.all(versions.map((version) => migration.write([{ id: "hot", version, text: `v${version}` }])));
	assert.deepEqual((await rows(fromTable)).map((r) => [r.version, r.text]), [[29, "v29"]]);
	assert.deepEqual((await rows(toTable)).map((r) => [r.version, r.text]), [[29, "v29"]]);
});
