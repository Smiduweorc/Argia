import { test } from "node:test";
import assert from "node:assert/strict";

import { ArgiaError, type Deletion, type Point, type VectorStore } from "../index.js";
import { checkVectorStore, type ConformanceOptions } from "../conformance.js";

type Meta = { label: string; scope: string };

interface Faults {
	unconditional?: boolean;
	twoStep?: boolean;
	noTombstones?: boolean;
	tiesIgnored?: boolean;
	dropsMetadata?: boolean;
	returnsDeleted?: boolean;
}

// A store that keeps the contract unless told which part of it to break.
function store(faults: Faults = {}): VectorStore<Meta, string> & { filters: (string | undefined)[] } {
	const rows = new Map<string, { point: Point<Meta>; deleted: boolean }>();
	const filters: (string | undefined)[] = [];
	const wins = (id: string, version: number): boolean => {
		const row = rows.get(id);
		if (row === undefined || faults.unconditional) return true;
		if (row.deleted && faults.noTombstones) return true;
		return faults.tiesIgnored ? version > row.point.version : version >= row.point.version;
	};
	return {
		filters,
		async upsert(points) {
			for (const point of points) {
				const write = wins(point.id, point.version);
				if (faults.twoStep) await new Promise((resolve) => setImmediate(resolve));
				if (write) rows.set(point.id, { point, deleted: false });
			}
		},
		async query(_vector, k, filter) {
			filters.push(filter);
			return [...rows.values()]
				.filter((row) => faults.returnsDeleted || !row.deleted)
				.slice(0, k)
				.map(({ point }) => ({ id: point.id, score: 1, ...(faults.dropsMetadata ? {} : { metadata: point.metadata }) }));
		},
		async delete(deletions: Deletion[]) {
			for (const { id, version } of deletions) {
				const write = wins(id, version);
				if (faults.twoStep) await new Promise((resolve) => setImmediate(resolve));
				if (write) {
					const old = rows.get(id)?.point;
					rows.set(id, { point: { id, version, text: "", vector: old?.vector ?? [], metadata: old?.metadata }, deleted: true });
				}
			}
		},
	};
}

function options(s: VectorStore<Meta, string>, overrides: Partial<ConformanceOptions<Meta, string>> = {}): ConformanceOptions<Meta, string> {
	return { store: s, dimensions: 3, idPrefix: "argia-check", metadata: (label) => ({ label, scope: "test" }), ...overrides };
}

async function failedChecks(faults: Faults): Promise<string[]> {
	try {
		await checkVectorStore(options(store(faults)));
	} catch (error) {
		assert.ok(error instanceof ArgiaError && error.code === "nonconformant_store", String(error));
		return error.failures.map((line) => line.slice(0, line.indexOf(":"))).sort();
	}
	return [];
}

test("a store that keeps the contract passes every check", async () => {
	await checkVectorStore(options(store()));
});

test("an unconditional upsert fails every ordering check", async () => {
	assert.deepEqual(await failedChecks({ unconditional: true }),
		["concurrent-delete", "concurrent-writes", "stale-write", "write-after-delete"]);
});

test("a store that reads the version and writes in a second step fails the concurrency checks only", async () => {
	assert.deepEqual(await failedChecks({ twoStep: true }), ["concurrent-delete", "concurrent-writes"]);
});

test("a delete that leaves no tombstone lets an older write bring the document back", async () => {
	assert.deepEqual(await failedChecks({ noTombstones: true }), ["concurrent-delete", "write-after-delete"]);
});

test("a store that ignores an equal version fails the retry and the write-at-delete checks", async () => {
	assert.deepEqual(await failedChecks({ tiesIgnored: true }), ["equal-version", "write-at-delete"]);
});

test("a query that returns deleted rows fails every delete check", async () => {
	assert.deepEqual(await failedChecks({ returnsDeleted: true }), ["concurrent-delete", "delete", "write-after-delete"]);
});

test("a store that drops metadata cannot show which version it kept", async () => {
	assert.deepEqual(await failedChecks({ dropsMetadata: true }),
		["concurrent-writes", "equal-version", "stale-write", "write-at-delete"]);
});

test("the error message names each failed check with the id and what came back", async () => {
	await assert.rejects(checkVectorStore(options(store({ tiesIgnored: true }))), (error) =>
		error instanceof ArgiaError
		&& error.message.startsWith("argia: the store breaks the version contract:\n")
		&& error.message.includes("equal-version: \"argia-check-equal-version\" came back with {\"label\":\"v1\",\"scope\":\"test\"}; expected {\"label\":\"v1-retry\",\"scope\":\"test\"}"));
});

test("a missing row is reported as missing, not as wrong metadata", async () => {
	const s = store();
	s.query = async () => [];
	await assert.rejects(checkVectorStore(options(s)), (error) =>
		error instanceof ArgiaError && error.failures.some((line) => line.startsWith("stale-write: \"argia-check-stale-write\" is missing")));
});

test("metadata that comes back with its keys in another order still matches", async () => {
	const s = store();
	const query = s.query.bind(s);
	s.query = async (vector, k, filter) => (await query(vector, k, filter)).map((hit) =>
		({ ...hit, metadata: hit.metadata && { scope: hit.metadata.scope, label: hit.metadata.label } }));
	await checkVectorStore(options(s));
});

test("metadata with an extra key does not match", async () => {
	const s = store();
	const query = s.query.bind(s);
	s.query = async (vector, k, filter) => (await query(vector, k, filter)).map((hit) =>
		({ ...hit, metadata: { ...hit.metadata, extra: 1 } as unknown as Meta }));
	await assert.rejects(checkVectorStore(options(s)), (error) => error instanceof ArgiaError && error.code === "nonconformant_store");
});

test("metadata missing a key does not match", async () => {
	const s = store();
	const query = s.query.bind(s);
	s.query = async (vector, k, filter) => (await query(vector, k, filter)).map((hit) =>
		({ ...hit, metadata: hit.metadata && ({ label: hit.metadata.label } as Meta) }));
	await assert.rejects(checkVectorStore(options(s)), (error) => error instanceof ArgiaError && error.code === "nonconformant_store");
});

test("the filter reaches every query, and is undefined when omitted", async () => {
	const withFilter = store();
	await checkVectorStore(options(withFilter, { filter: "tenant = scratch" }));
	assert.ok(withFilter.filters.length > 0);
	assert.ok(withFilter.filters.every((filter) => filter === "tenant = scratch"));
	const without = store();
	await checkVectorStore(options(without));
	assert.ok(without.filters.every((filter) => filter === undefined));
});

test("every test point uses the prefix and the declared dimensions", async () => {
	const s = store();
	const seen: Point<Meta>[] = [];
	const upsert = s.upsert.bind(s);
	s.upsert = async (points) => { seen.push(...points); await upsert(points); };
	await checkVectorStore(options(s, { dimensions: 5, idPrefix: "scratch" }));
	assert.ok(seen.length > 0);
	assert.ok(seen.every((point) => point.id.startsWith("scratch-") && point.vector.length === 5));
	assert.deepEqual(seen[0]?.vector, [1, 0, 0, 0, 0]);
});

test("an error thrown by the store is rethrown unchanged", async () => {
	const boom = new Error("connection refused");
	const s = store();
	s.delete = async () => { throw boom; };
	await assert.rejects(checkVectorStore(options(s)), (error) => error === boom);
});

test("the options are validated before the store is touched", async () => {
	const s = store();
	let calls = 0;
	s.upsert = async () => { calls++; };
	const cases: [string, Partial<ConformanceOptions<Meta, string>>][] = [
		["missing store", { store: undefined as unknown as VectorStore<Meta, string> }],
		["store missing query", { store: { upsert: s.upsert, delete: s.delete } as unknown as VectorStore<Meta, string> }],
		["zero dimensions", { dimensions: 0 }],
		["fractional dimensions", { dimensions: 2.5 }],
		["NaN dimensions", { dimensions: NaN }],
		["empty idPrefix", { idPrefix: "" }],
		["missing idPrefix", { idPrefix: undefined as unknown as string }],
		["metadata not a function", { metadata: {} as unknown as (label: string) => Meta }],
	];
	for (const [name, overrides] of cases) {
		await assert.rejects(checkVectorStore(options(s, overrides)), (error) =>
			error instanceof ArgiaError && error.code === "invalid_options", name);
	}
	await assert.rejects(checkVectorStore(undefined as unknown as ConformanceOptions<Meta, string>), (error) =>
		error instanceof ArgiaError && error.code === "invalid_options");
	assert.equal(calls, 0);
});

test("errors from other codes carry an empty failures list", () => {
	assert.deepEqual(new ArgiaError("invalid_k", "k").failures, []);
});
