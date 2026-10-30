import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { ArgiaError, Migration, type Deletion, type Phase, type Point, type Profile, type VectorStore } from "../index.js";
import { checkVectorStore } from "../conformance.js";
import { phases, route } from "../src/route.js";

type Row = { point: Point<unknown>; deleted: boolean };

// Keeps the version contract; `serialise` makes metadata take a JSON round trip with its keys reversed, as a real store might.
function store(serialise = false): VectorStore<unknown> & { rows: Map<string, Row> } {
	const rows = new Map<string, Row>();
	const wins = (id: string, version: number): boolean => version >= (rows.get(id)?.point.version ?? -1);
	const reverse = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(reverse);
		if (typeof value !== "object" || value === null) return value;
		return Object.fromEntries(Object.entries(value).reverse().map(([key, inner]) => [key, reverse(inner)]));
	};
	return {
		rows,
		async upsert(points) {
			for (const point of points) {
				if (wins(point.id, point.version)) rows.set(point.id, { point, deleted: false });
			}
		},
		async query(_vector, k) {
			return [...rows.values()].filter((row) => !row.deleted).slice(0, k).map(({ point }) => ({
				id: point.id,
				score: 1,
				metadata: serialise && point.metadata !== undefined ? reverse(JSON.parse(JSON.stringify(point.metadata))) : point.metadata,
			}));
		},
		async delete(deletions: Deletion[]) {
			for (const { id, version } of deletions) {
				if (wins(id, version)) rows.set(id, { point: { id, version, text: "", vector: [] }, deleted: true });
			}
		},
	};
}

function profile(name: string): Profile<unknown> & { store: ReturnType<typeof store> } {
	return { name, dimensions: 2, embed: async (texts) => texts.map(() => [1, 0]), store: store() };
}

test("every phase reads from a side it also writes to, and only to-only leaves the old side", () => {
	fc.assert(fc.property(fc.constantFrom(...phases), (phase) => {
		const plan = route(phase);
		assert.ok(plan.writes.includes(plan.read));
		assert.equal(plan.writes.includes("from"), phase !== "to-only");
		assert.equal(plan.compare, phase === "compare");
	}));
});

test("a write is accepted exactly when every id is a non-empty, unique string and every version is finite and not negative", async () => {
	const id = fc.oneof(fc.string(), fc.constant(""), fc.integer(), fc.constant(undefined));
	const version = fc.oneof(fc.double(), fc.integer({ min: -5, max: 5 }), fc.constant("1"), fc.constant(undefined));
	await fc.assert(fc.asyncProperty(fc.array(fc.record({ id, version }), { maxLength: 6 }), async (entries) => {
		const migration = new Migration({ from: profile("a"), to: profile("b"), phase: "from", shadowWriteFailure: "throw", compareRate: 0 });
		const documents = entries.map((entry) => ({ ...entry, text: "t" })) as never[];
		const ids = entries.map((entry) => entry.id);
		const valid = entries.every((entry) => typeof entry.id === "string" && entry.id !== ""
			&& typeof entry.version === "number" && Number.isFinite(entry.version) && entry.version >= 0)
			&& new Set(ids).size === ids.length;
		try {
			await migration.write(documents);
			assert.ok(valid, `accepted ${JSON.stringify(entries)}`);
		} catch (error) {
			assert.ok(!valid, `refused ${JSON.stringify(entries)}: ${String(error)}`);
			assert.ok(error instanceof ArgiaError && ["invalid_id", "invalid_version", "duplicate_id"].includes(error.code), String(error));
		}
	}));
});

test("whatever order writes, backfills and deletes land in, both stores end at the highest version", async () => {
	const operation = fc.record({
		kind: fc.constantFrom("write", "backfill", "delete"),
		id: fc.constantFrom("a", "b", "c"),
		version: fc.integer({ min: 0, max: 20 }),
	});
	await fc.assert(fc.asyncProperty(fc.array(operation, { maxLength: 25 }), fc.scheduler(), async (operations, s) => {
		const from = profile("from");
		const to = profile("to");
		const migration = new Migration({ from, to, phase: "from", shadowWriteFailure: "throw", compareRate: 0 });
		// Each store call waits on the scheduler, so fast-check picks the interleaving.
		for (const side of [from.store, to.store]) {
			side.upsert = s.scheduleFunction(side.upsert.bind(side));
			side.delete = s.scheduleFunction(side.delete.bind(side));
		}
		const calls = operations.map((op) => op.kind === "delete"
			? migration.delete([{ id: op.id, version: op.version }])
			: migration[op.kind]([{ id: op.id, version: op.version, text: `${op.kind}@${op.version}` }]));
		await s.waitFor(Promise.all(calls));
		for (const id of ["a", "b", "c"]) {
			const touching = operations.filter((op) => op.id === id);
			const top = Math.max(-1, ...touching.map((op) => op.version));
			const winners = touching.filter((op) => op.version === top);
			const toRow = to.store.rows.get(id);
			assert.equal(toRow?.point.version ?? -1, top, `to ${id}`);
			// Ties between a delete and a write at one version go to whichever landed last; either is a valid outcome.
			assert.ok(toRow === undefined || winners.some((op) => (op.kind === "delete") === toRow.deleted), `to ${id} kind`);
			const fromTop = Math.max(-1, ...touching.filter((op) => op.kind !== "backfill").map((op) => op.version));
			assert.equal(from.store.rows.get(id)?.point.version ?? -1, fromTop, `from ${id}`);
		}
	}), { numRuns: 200 });
});

test("a query is compared exactly when the draw is below compareRate", async () => {
	await fc.assert(fc.asyncProperty(fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }), async (rate, draw) => {
		const to = profile("to");
		let queried = 0;
		to.store.query = async () => { queried++; return []; };
		const migration = new Migration({ from: profile("from"), to, phase: "compare" as Phase, shadowWriteFailure: "throw", compareRate: rate, random: () => draw });
		await migration.query("q", 1);
		assert.equal(queried, draw < rate ? 1 : 0);
	}), { examples: [[0.5, 0.5], [0, 0], [1, 0.9999999999999999], [0.25, 0.25]] });
});

test("the conformance check accepts any JSON metadata that survives the store's round trip with keys reordered", async () => {
	await fc.assert(fc.asyncProperty(fc.dictionary(fc.string(), fc.jsonValue()), async (extra) => {
		await checkVectorStore({ store: store(true), dimensions: 2, idPrefix: "p", metadata: (label) => ({ ...extra, label }) });
	}), { numRuns: 50 });
});

test("the conformance check refuses a store that changes any one metadata value", async () => {
	await fc.assert(fc.asyncProperty(fc.dictionary(fc.string({ minLength: 1 }), fc.jsonValue(), { minKeys: 1 }), async (extra) => {
		const s = store(true);
		const query = s.query.bind(s);
		const key = Object.keys(extra)[0] as string;
		s.query = async (vector, k, filter) => (await query(vector, k, filter)).map((hit) =>
			({ ...hit, metadata: { ...(hit.metadata as object), [key]: { changed: true } } }));
		await assert.rejects(checkVectorStore({ store: s, dimensions: 2, idPrefix: "p", metadata: (label) => ({ ...extra, label }) }),
			(error) => error instanceof ArgiaError && error.code === "nonconformant_store");
	}), { numRuns: 50 });
});
