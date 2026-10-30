import { test } from "node:test";
import assert from "node:assert/strict";

import { ArgiaError, Migration, type MigrationEvent, type MigrationOptions, type Phase, type Point, type Profile, type VectorStore } from "../index.js";

interface Store extends VectorStore<{ tag: string }, string> {
	readonly points: Map<string, Point<{ tag: string }>>;
	readonly tombstones: Map<string, number>;
	fail: Error | undefined;
	queries: number;
	filters: (string | undefined)[];
	log: string[];
}

// Hits are every stored id sorted, so a query's result is predictable without real geometry.
// Writes honour the VectorStore version contract: the higher version wins, ties replace, deletes leave tombstones.
function store(name: string, log: string[]): Store {
	const points = new Map<string, Point<{ tag: string }>>();
	const tombstones = new Map<string, number>();
	const stored = (id: string): number => Math.max(points.get(id)?.version ?? -1, tombstones.get(id) ?? -1);
	const s: Store = {
		points,
		tombstones,
		fail: undefined,
		queries: 0,
		filters: [],
		log,
		async upsert(batch) {
			log.push(`${name}.upsert`);
			if (s.fail) throw s.fail;
			for (const point of batch) {
				if (point.version >= stored(point.id)) {
					points.set(point.id, point);
					tombstones.delete(point.id);
				}
			}
		},
		async query(_vector, k, filter) {
			s.queries++;
			s.filters.push(filter);
			if (s.fail) throw s.fail;
			return [...points.keys()].sort().slice(0, k).map((id, i) => ({ id, score: 1 - i / 10 }));
		},
		async delete(deletions) {
			log.push(`${name}.delete`);
			if (s.fail) throw s.fail;
			for (const { id, version } of deletions) {
				if (version >= stored(id)) {
					points.delete(id);
					tombstones.set(id, version);
				}
			}
		},
	};
	return s;
}

const log: string[] = [];

function profile(name: string, dimensions: number, embed?: (texts: string[]) => Promise<number[][]>): Profile<{ tag: string }, string> & { store: Store; calls: string[][] } {
	const calls: string[][] = [];
	return {
		name,
		dimensions,
		store: store(name, log),
		calls,
		embed: embed ?? (async (texts) => {
			calls.push(texts);
			return texts.map((text) => Array.from({ length: dimensions }, (_, i) => text.length + i));
		}),
	};
}

function build(overrides: Partial<MigrationOptions<{ tag: string }, string>> = {}): {
	migration: Migration<{ tag: string }, string>;
	from: ReturnType<typeof profile>;
	to: ReturnType<typeof profile>;
	events: MigrationEvent<{ tag: string }>[];
} {
	log.length = 0;
	const from = profile("ada-002", 3);
	const to = profile("embed-v4", 5);
	const events: MigrationEvent<{ tag: string }>[] = [];
	const migration = new Migration({
		from,
		to,
		phase: "from",
		shadowWriteFailure: "throw",
		compareRate: 1,
		onEvent: (event) => events.push(event),
		...overrides,
	});
	return { migration, from: (overrides.from as typeof from) ?? from, to: (overrides.to as typeof to) ?? to, events };
}

const docs = [
	{ id: "a", version: 1, text: "ants", metadata: { tag: "x" } },
	{ id: "b", version: 1, text: "bees" },
];

function code(expected: string): (error: unknown) => boolean {
	return (error) => error instanceof ArgiaError && error.code === expected;
}

test("a write in the from phase embeds with both models and stores each model's vectors in its own store", async () => {
	const { migration, from, to } = build();
	await migration.write(docs);
	assert.deepEqual(from.calls, [["ants", "bees"]]);
	assert.deepEqual(to.calls, [["ants", "bees"]]);
	assert.deepEqual(from.store.points.get("a"), { id: "a", version: 1, text: "ants", metadata: { tag: "x" }, vector: [4, 5, 6] });
	assert.deepEqual(to.store.points.get("b"), { id: "b", version: 1, text: "bees", vector: [4, 5, 6, 7, 8] });
});

for (const phase of ["from", "compare", "to"] as Phase[]) {
	test(`the ${phase} phase writes and deletes on both stores`, async () => {
		const { migration, from, to } = build({ phase });
		await migration.write(docs);
		await migration.delete([{ id: "a", version: 2 }]);
		assert.deepEqual([...from.store.points.keys()], ["b"]);
		assert.deepEqual([...to.store.points.keys()], ["b"]);
	});
}

test("the to-only phase never touches the old model or store", async () => {
	const { migration, from, to } = build({ phase: "to-only" });
	from.store.points.set("old", { id: "old", version: 1, text: "", vector: [0, 0, 0] });
	await migration.write(docs);
	await migration.delete([{ id: "old", version: 2 }]);
	await migration.query("q", 1);
	assert.deepEqual(from.calls, []);
	assert.deepEqual([...from.store.points.keys()], ["old"]);
	assert.equal(from.store.queries, 0);
	assert.deepEqual([...to.store.points.keys()], ["a", "b"]);
});

test("queries read from the from store in from, and from the to store in to", async () => {
	const { migration, from, to } = build();
	from.store.points.set("old", { id: "old", version: 1, text: "", vector: [0, 0, 0] });
	to.store.points.set("new", { id: "new", version: 1, text: "", vector: [0, 0, 0, 0, 0] });
	assert.deepEqual((await migration.query("q", 5)).map((hit) => hit.id), ["old"]);
	migration.setPhase("to");
	assert.deepEqual((await migration.query("q", 5)).map((hit) => hit.id), ["new"]);
	assert.equal(from.store.queries, 1);
	assert.equal(to.store.queries, 1);
});

test("a query embeds its text with the model of the store it reads", async () => {
	const { migration, from, to } = build({ phase: "to" });
	await migration.query("question", 1);
	assert.deepEqual(from.calls, []);
	assert.deepEqual(to.calls, [["question"]]);
});

test("the compare phase returns the from results and reports both hit lists", async () => {
	const { migration, from, to, events } = build({ phase: "compare" });
	from.store.points.set("x", { id: "x", version: 1, text: "", vector: [0, 0, 0] });
	from.store.points.set("y", { id: "y", version: 1, text: "", vector: [0, 0, 0] });
	to.store.points.set("y", { id: "y", version: 1, text: "", vector: [0, 0, 0, 0, 0] });
	const hits = await migration.query("q", 2);
	assert.deepEqual(hits, [{ id: "x", score: 1 }, { id: "y", score: 0.9 }]);
	assert.deepEqual(events, [{ type: "compare", text: "q", k: 2, from: [{ id: "x", score: 1 }, { id: "y", score: 0.9 }], to: [{ id: "y", score: 1 }] }]);
});

test("a failing comparison query is reported and the read still succeeds", async () => {
	const { migration, to, events } = build({ phase: "compare" });
	const boom = new Error("to is down");
	to.store.fail = boom;
	assert.deepEqual(await migration.query("q", 1), []);
	assert.deepEqual(events, [{ type: "shadow_query_failed", profile: "embed-v4", text: "q", error: boom }]);
});

test("a failing read in compare rethrows the store's own error and reports nothing", async () => {
	const { migration, from, events } = build({ phase: "compare" });
	const boom = new Error("from is down");
	from.store.fail = boom;
	await assert.rejects(migration.query("q", 1), (error) => error === boom);
	assert.deepEqual(events, []);
});

test("phases other than compare emit no events on a query", async () => {
	for (const phase of ["from", "to", "to-only"] as Phase[]) {
		const { migration, events } = build({ phase });
		await migration.query("q", 1);
		assert.deepEqual(events, [], phase);
	}
});

test("a failed write on the side being read throws the caller's error unchanged, even with report", async () => {
	for (const [phase, side] of [["from", "from"], ["to", "to"], ["to-only", "to"]] as const) {
		const { migration, from, to, events } = build({ phase, shadowWriteFailure: "report" });
		const boom = new Error(`${side} upsert`);
		(side === "from" ? from : to).store.fail = boom;
		await assert.rejects(migration.write(docs), (error) => error === boom, phase);
		assert.deepEqual(events, [], phase);
	}
});

test("a failed shadow write with throw is reported and then rethrown unchanged", async () => {
	const { migration, from, to, events } = build({ shadowWriteFailure: "throw" });
	const boom = new Error("to upsert");
	to.store.fail = boom;
	await assert.rejects(migration.write(docs), (error) => error === boom);
	assert.deepEqual([...from.store.points.keys()], ["a", "b"]);
	assert.deepEqual(events, [{ type: "shadow_write_failed", operation: "write", profile: "embed-v4", ids: ["a", "b"], error: boom }]);
});

test("a failed shadow write with report succeeds and reports it", async () => {
	const { migration, from, events } = build({ phase: "to", shadowWriteFailure: "report" });
	const boom = new Error("from delete");
	from.store.fail = boom;
	await migration.delete([{ id: "a", version: 2 }, { id: "b", version: 2 }]);
	assert.deepEqual(events, [{ type: "shadow_write_failed", operation: "delete", profile: "ada-002", ids: ["a", "b"], error: boom }]);
});

test("a failed write on the read side leaves the other side untouched", async () => {
	const { migration, from, to, events } = build();
	const readSide = new Error("from");
	from.store.fail = readSide;
	await assert.rejects(migration.write(docs), (error) => error === readSide);
	assert.deepEqual(to.calls, []);
	assert.equal(to.store.points.size, 0);
	assert.equal(events.length, 0);
});

test("a failed delete on the read side leaves the other side untouched", async () => {
	const { migration, from, to } = build({ phase: "to" });
	await migration.write(docs);
	const readSide = new Error("to");
	to.store.fail = readSide;
	await assert.rejects(migration.delete([{ id: "a", version: 2 }]), (error) => error === readSide);
	assert.deepEqual([...from.store.points.keys()], ["a", "b"]);
});

test("the read side is written and deleted before the other side, in every dual phase", async () => {
	const expected: Record<string, string[]> = {
		from: ["ada-002.upsert", "embed-v4.upsert", "ada-002.delete", "embed-v4.delete"],
		compare: ["ada-002.upsert", "embed-v4.upsert", "ada-002.delete", "embed-v4.delete"],
		to: ["embed-v4.upsert", "ada-002.upsert", "embed-v4.delete", "ada-002.delete"],
	};
	for (const phase of ["from", "compare", "to"] as Phase[]) {
		const { migration } = build({ phase });
		await migration.write(docs);
		await migration.delete([{ id: "a", version: 2 }]);
		assert.deepEqual(log, expected[phase], phase);
	}
});

test("the other side's write does not start until the read side's write has finished", async () => {
	let open!: () => void;
	const gate = new Promise<void>((resolve) => { open = resolve; });
	const from = profile("ada-002", 3, async (texts) => { await gate; return texts.map(() => [0, 0, 0]); });
	const { migration, to } = build({ from });
	const running = migration.write(docs);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(to.calls, []);
	open();
	await running;
	assert.equal(to.calls.length, 1);
});

test("a listener that throws does not fail the call", async () => {
	const { migration, to } = build({ shadowWriteFailure: "report", onEvent: () => { throw new Error("listener"); } });
	to.store.fail = new Error("to");
	await migration.write(docs);
});

test("without a listener, reported failures are dropped and the call succeeds", async () => {
	const { migration, to } = build({ shadowWriteFailure: "report", onEvent: undefined });
	to.store.fail = new Error("to");
	await migration.write(docs);
	await migration.query("q", 1);
});

test("an error thrown by embed passes through unchanged", async () => {
	const boom = new Error("rate limited");
	const from = profile("ada-002", 3, async () => { throw boom; });
	const { migration } = build({ from });
	await assert.rejects(migration.write(docs), (error) => error === boom);
});

test("empty writes and deletes call nothing", async () => {
	const { migration, from, to } = build();
	from.store.fail = new Error("must not be called");
	await migration.write([]);
	await migration.delete([]);
	assert.deepEqual(from.calls, []);
	assert.deepEqual(to.calls, []);
});

test("a single-document write works", async () => {
	const { migration, to } = build();
	await migration.write([{ id: "only", version: 1, text: "" }]);
	assert.deepEqual(to.store.points.get("only")?.vector, [0, 1, 2, 3, 4]);
});

test("duplicate ids in one write are refused before anything is embedded", async () => {
	const { migration, from } = build();
	await assert.rejects(migration.write([docs[0]!, docs[1]!, { id: "a", version: 1, text: "again" }]), (error) =>
		code("duplicate_id")(error) && (error as ArgiaError).documentId === "a");
	assert.deepEqual(from.calls, []);
});

test("empty or non-string ids are refused on write and delete", async () => {
	const { migration } = build();
	await assert.rejects(migration.write([{ id: "", version: 1, text: "t" }]), code("invalid_id"));
	await assert.rejects(migration.write([{ id: 7 as unknown as string, version: 1, text: "t" }]), code("invalid_id"));
	await assert.rejects(migration.delete([{ id: "a", version: 2 }, { id: "", version: 2 }]), code("invalid_id"));
});

test("unicode ids and texts are stored as given", async () => {
	const { migration, to } = build();
	await migration.write([{ id: "fourmi-\u00e9", version: 1, text: "\u{1F41C}" }]);
	assert.equal(to.store.points.get("fourmi-\u00e9")?.text, "\u{1F41C}");
});

test("k must be a positive integer", async () => {
	const { migration } = build();
	for (const k of [0, -1, 1.5, NaN, Infinity]) {
		await assert.rejects(migration.query("q", k), code("invalid_k"), String(k));
	}
	await migration.query("q", 1);
});

test("an embed returning the wrong number of vectors is refused with the profile name", async () => {
	const to = profile("embed-v4", 2, async () => [[1, 2]]);
	const { migration } = build({ to });
	await assert.rejects(migration.write(docs), (error) =>
		code("embedding_count_mismatch")(error) && (error as ArgiaError).profile === "embed-v4");
});

test("an embed returning a non-array is refused", async () => {
	const to = profile("embed-v4", 2, async () => null as unknown as number[][]);
	const { migration } = build({ to });
	await assert.rejects(migration.write(docs), code("embedding_count_mismatch"));
});

test("a vector one short or one long of the declared dimensions is refused", async () => {
	for (const length of [4, 6]) {
		const to = profile("embed-v4", 5, async (texts) => texts.map(() => new Array<number>(length).fill(0)));
		const { migration, from } = build({ to });
		await assert.rejects(migration.write(docs), code("embedding_dimension_mismatch"));
		// The read side was written first and keeps the documents; the stores diverge until the write is repeated.
		assert.equal(from.store.points.size, 2);
	}
});

test("vectors containing NaN or Infinity are refused, on writes and on queries", async () => {
	for (const bad of [NaN, Infinity, -Infinity]) {
		const from = profile("ada-002", 3, async (texts) => texts.map(() => [0, bad, 0]));
		const { migration } = build({ from });
		await assert.rejects(migration.write(docs), code("embedding_not_finite"));
		await assert.rejects(migration.query("q", 1), code("embedding_not_finite"));
	}
});

test("setPhase changes where the next call goes and the phase getter reflects it", async () => {
	const { migration } = build();
	assert.equal(migration.phase, "from");
	migration.setPhase("to-only");
	assert.equal(migration.phase, "to-only");
	assert.throws(() => migration.setPhase("both" as Phase), code("invalid_phase"));
	assert.equal(migration.phase, "to-only");
});

test("a write already running keeps the phase it started with", async () => {
	let open!: () => void;
	const gate = new Promise<void>((resolve) => { open = resolve; });
	const from = profile("ada-002", 3, async (texts) => { await gate; return texts.map(() => [0, 0, 0]); });
	const { migration, to } = build({ from });
	const running = migration.write(docs);
	migration.setPhase("to-only");
	open();
	await running;
	assert.equal(from.store.points.size, 2);
	assert.equal(to.store.points.size, 2);
});

test("the constructor refuses every malformed option", () => {
	const good = (): MigrationOptions<{ tag: string }, string> => ({ from: profile("a", 1), to: profile("b", 1), phase: "from", shadowWriteFailure: "throw", compareRate: 1 });
	const cases: [string, (o: MigrationOptions<{ tag: string }, string>) => unknown][] = [
		["missing from", (o) => ({ ...o, from: undefined })],
		["missing to", (o) => ({ ...o, to: null })],
		["empty name", (o) => ({ ...o, from: { ...o.from, name: "" } })],
		["same name", (o) => ({ ...o, to: { ...o.to, name: "a" } })],
		["shared store", (o) => ({ ...o, to: { ...o.to, store: o.from.store } })],
		["zero dimensions", (o) => ({ ...o, from: { ...o.from, dimensions: 0 } })],
		["negative dimensions", (o) => ({ ...o, from: { ...o.from, dimensions: -3 } })],
		["fractional dimensions", (o) => ({ ...o, from: { ...o.from, dimensions: 1.5 } })],
		["NaN dimensions", (o) => ({ ...o, to: { ...o.to, dimensions: NaN } })],
		["Infinity dimensions", (o) => ({ ...o, to: { ...o.to, dimensions: Infinity } })],
		["string dimensions", (o) => ({ ...o, to: { ...o.to, dimensions: "3" } })],
		["embed not a function", (o) => ({ ...o, to: { ...o.to, embed: "x" } })],
		["missing store", (o) => ({ ...o, to: { ...o.to, store: undefined } })],
		["store missing delete", (o) => ({ ...o, to: { ...o.to, store: { upsert: async () => {}, query: async () => [] } } })],
		["missing shadowWriteFailure", (o) => ({ ...o, shadowWriteFailure: undefined })],
		["unknown shadowWriteFailure", (o) => ({ ...o, shadowWriteFailure: "ignore" })],
		["onEvent not a function", (o) => ({ ...o, onEvent: "log" })],
		["random not a function", (o) => ({ ...o, random: 0.5 })],
		["missing compareRate", (o) => ({ ...o, compareRate: undefined })],
		["negative compareRate", (o) => ({ ...o, compareRate: -0.01 })],
		["compareRate over 1", (o) => ({ ...o, compareRate: 1.01 })],
		["NaN compareRate", (o) => ({ ...o, compareRate: NaN })],
		["string compareRate", (o) => ({ ...o, compareRate: "1" })],
	];
	for (const [name, mutate] of cases) {
		assert.throws(() => new Migration(mutate(good()) as MigrationOptions<{ tag: string }, string>), code("invalid_options"), name);
	}
	assert.throws(() => new Migration(undefined as unknown as MigrationOptions<unknown>), code("invalid_options"));
	assert.throws(() => new Migration({ ...good(), phase: "start" as Phase }), code("invalid_phase"));
	assert.throws(() => new Migration({ ...good(), phase: undefined as unknown as Phase }), code("invalid_phase"));
});

test("errors carry the argia prefix and the ArgiaError name", () => {
	const error = new ArgiaError("invalid_k", "k must be a positive integer");
	assert.equal(error.message, "argia: k must be a positive integer");
	assert.equal(error.name, "ArgiaError");
	assert.ok(error instanceof Error);
});

test("compareRate 0 and 1 are accepted at the edges", () => {
	build({ compareRate: 0 });
	build({ compareRate: 1 });
});

test("compareRate 0 never queries the other side", async () => {
	const { migration, to, events } = build({ phase: "compare", compareRate: 0, random: () => 0 });
	await migration.query("q", 1);
	assert.equal(to.store.queries, 0);
	assert.deepEqual(events, []);
});

test("a query is compared when the random draw is below compareRate, and not at or above it", async () => {
	for (const [draw, compared] of [[0.24, true], [0.25, false], [0.26, false], [0, true]] as const) {
		const { migration, to, events } = build({ phase: "compare", compareRate: 0.25, random: () => draw });
		await migration.query("q", 1);
		assert.equal(to.store.queries, compared ? 1 : 0, String(draw));
		assert.equal(events.length, compared ? 1 : 0, String(draw));
	}
});

test("compareRate 1 compares even on the highest draw", async () => {
	const { migration, to } = build({ phase: "compare", compareRate: 1, random: () => 0.9999999 });
	await migration.query("q", 1);
	assert.equal(to.store.queries, 1);
});

test("random defaults to Math.random", async () => {
	const original = Math.random;
	try {
		for (const [draw, queries] of [[0.9, 0], [0.1, 1]] as const) {
			Math.random = () => draw;
			const { migration, to } = build({ phase: "compare", compareRate: 0.5, random: undefined });
			await migration.query("q", 1);
			assert.equal(to.store.queries, queries, String(draw));
		}
	} finally {
		Math.random = original;
	}
});

test("random is not drawn outside the compare phase", async () => {
	let draws = 0;
	for (const phase of ["from", "to", "to-only"] as Phase[]) {
		const { migration } = build({ phase, random: () => { draws++; return 0; } });
		await migration.query("q", 1);
	}
	assert.equal(draws, 0);
});

test("a filter reaches the store being read, and both stores when compared", async () => {
	const { migration, from, to } = build({ phase: "compare" });
	await migration.query("q", 1, "tenant = 7");
	assert.deepEqual(from.store.filters, ["tenant = 7"]);
	assert.deepEqual(to.store.filters, ["tenant = 7"]);
	migration.setPhase("to");
	await migration.query("q", 1, "source = wiki");
	assert.deepEqual(to.store.filters, ["tenant = 7", "source = wiki"]);
});

test("a query without a filter passes undefined to the store", async () => {
	const { migration, from } = build();
	await migration.query("q", 1);
	assert.deepEqual(from.store.filters, [undefined]);
});

test("backfill writes only to the to profile, in every phase", async () => {
	for (const phase of ["from", "compare", "to", "to-only"] as Phase[]) {
		const { migration, from, to, events } = build({ phase });
		await migration.backfill(docs);
		assert.deepEqual(from.calls, [], phase);
		assert.equal(from.store.points.size, 0, phase);
		assert.deepEqual(to.store.points.get("a"), { id: "a", version: 1, text: "ants", metadata: { tag: "x" }, vector: [4, 5, 6, 7, 8] }, phase);
		assert.deepEqual(events, [], phase);
	}
});

test("backfill throws store errors even when shadow failures are reported", async () => {
	const { migration, to, events } = build({ shadowWriteFailure: "report" });
	const boom = new Error("to upsert");
	to.store.fail = boom;
	await assert.rejects(migration.backfill(docs), (error) => error === boom);
	assert.deepEqual(events, []);
});

test("backfill validates ids and embeddings like write", async () => {
	const { migration } = build();
	await assert.rejects(migration.backfill([docs[0]!, docs[0]!]), code("duplicate_id"));
	await assert.rejects(migration.backfill([{ id: "", version: 1, text: "t" }]), code("invalid_id"));
	const to = profile("embed-v4", 5, async () => [[1, 2]]);
	await assert.rejects(build({ to }).migration.backfill(docs), code("embedding_count_mismatch"));
});

test("an empty backfill calls nothing", async () => {
	const { migration, to } = build();
	await migration.backfill([]);
	assert.deepEqual(to.calls, []);
});

test("an old backfill landing after a newer live write leaves the newer copy in place", async () => {
	const { migration, to } = build();
	await migration.write([{ id: "a", version: 5, text: "edited" }]);
	await migration.backfill([{ id: "a", version: 4, text: "stale" }]);
	assert.equal(to.store.points.get("a")?.text, "edited");
});

test("two writers interleaving across the stores still leave both stores with the newer copy", async () => {
	let open!: () => void;
	const gate = new Promise<void>((resolve) => { open = resolve; });
	let held = true;
	// The first to-embed call (writer A's shadow write) waits until writer B has finished both stores.
	const to = profile("embed-v4", 5, async (texts) => {
		if (held) { held = false; await gate; }
		return texts.map((text) => [text.length, 0, 0, 0, 0]);
	});
	const { migration, from } = build({ to });
	const writerA = migration.write([{ id: "a", version: 1, text: "first" }]);
	await new Promise((resolve) => setImmediate(resolve));
	await migration.write([{ id: "a", version: 2, text: "second" }]);
	open();
	await writerA;
	assert.equal(from.store.points.get("a")?.text, "second");
	assert.equal(to.store.points.get("a")?.text, "second");
});

test("a write older than a delete does not bring the document back", async () => {
	const { migration, from, to } = build();
	await migration.write([{ id: "a", version: 1, text: "ants" }]);
	await migration.delete([{ id: "a", version: 3 }]);
	await migration.backfill([{ id: "a", version: 2, text: "ants" }]);
	await migration.write([{ id: "a", version: 3, text: "ants" }]);
	assert.equal(from.store.points.has("a"), true);
	assert.equal(to.store.points.has("a"), true);
	await migration.delete([{ id: "a", version: 4 }]);
	await migration.write([{ id: "a", version: 2, text: "late" }]);
	assert.equal(from.store.points.has("a"), false);
	assert.equal(to.store.points.has("a"), false);
});

test("retrying a write at the same version replaces the stored copy", async () => {
	const { migration, to } = build();
	await migration.write([{ id: "a", version: 1, text: "ants" }]);
	await migration.write([{ id: "a", version: 1, text: "ants!" }]);
	assert.equal(to.store.points.get("a")?.text, "ants!");
});

test("deletes reach each store with their versions, read side first", async () => {
	const seen: string[] = [];
	const { migration, from, to } = build({ phase: "to" });
	for (const [name, profile] of [["from", from], ["to", to]] as const) {
		const original = profile.store.delete;
		profile.store.delete = async (deletions) => { seen.push(`${name}:${JSON.stringify(deletions)}`); await original(deletions); };
	}
	await migration.delete([{ id: "a", version: 7 }]);
	assert.deepEqual(seen, ["to:[{\"id\":\"a\",\"version\":7}]", "from:[{\"id\":\"a\",\"version\":7}]"]);
});

test("versions must be finite and non-negative, on write, backfill and delete", async () => {
	const { migration } = build();
	for (const version of [-1, NaN, Infinity, -Infinity, "1" as unknown as number, undefined as unknown as number]) {
		await assert.rejects(migration.write([{ id: "a", version, text: "t" }]), (error) =>
			code("invalid_version")(error) && (error as ArgiaError).documentId === "a", String(version));
		await assert.rejects(migration.backfill([{ id: "a", version, text: "t" }]), code("invalid_version"), String(version));
		await assert.rejects(migration.delete([{ id: "a", version }]), code("invalid_version"), String(version));
	}
	await migration.write([{ id: "a", version: 0, text: "zero is allowed" }]);
	await migration.write([{ id: "b", version: 1.5, text: "fractions are allowed" }]);
});

test("one id twice in a delete is refused before any store is called", async () => {
	const { migration } = build();
	await assert.rejects(migration.delete([{ id: "a", version: 1 }, { id: "a", version: 2 }]), code("duplicate_id"));
	assert.deepEqual(log, []);
});

test("an async listener that rejects is ignored and never becomes an unhandled rejection", async () => {
	const unhandled: unknown[] = [];
	const record = (reason: unknown): void => { unhandled.push(reason); };
	process.on("unhandledRejection", record);
	try {
		const { migration, to } = build({ shadowWriteFailure: "report", onEvent: async () => { throw new Error("listener"); } });
		to.store.fail = new Error("to");
		await migration.write(docs);
		await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(unhandled, []);
	} finally {
		process.off("unhandledRejection", record);
	}
});

test("an async listener is not awaited", async () => {
	let finished = false;
	const { migration } = build({ phase: "compare", onEvent: async () => { await new Promise((resolve) => setImmediate(resolve)); finished = true; } });
	await migration.query("q", 1);
	assert.equal(finished, false);
});

test("a random draw outside [0, 1) is refused", async () => {
	for (const draw of [1, -0.1, NaN, Infinity, "0.5" as unknown as number]) {
		const { migration } = build({ phase: "compare", random: () => draw });
		await assert.rejects(migration.query("q", 1), (error) =>
			code("invalid_options")(error) && (error as ArgiaError).message.includes("random must return"), String(draw));
	}
});

test("hits that break the store contract are refused with the profile name", async () => {
	const bad: [string, unknown][] = [
		["not an array", { id: "a", score: 1 }],
		["more than k", [{ id: "a", score: 1 }, { id: "b", score: 0.5 }]],
		["empty id", [{ id: "", score: 1 }]],
		["numeric id", [{ id: 1, score: 1 }]],
		["missing score", [{ id: "a" }]],
		["NaN score", [{ id: "a", score: NaN }]],
		["null hit", [null]],
	];
	for (const [name, result] of bad) {
		const { migration, from } = build();
		from.store.query = async () => result as never;
		await assert.rejects(migration.query("q", 1), (error) =>
			code("invalid_store_result")(error) && (error as ArgiaError).profile === "ada-002", name);
	}
});

test("exactly k hits, and zero hits, are accepted", async () => {
	const { migration, from } = build();
	from.store.query = async () => [{ id: "a", score: 1 }, { id: "b", score: 0.5 }];
	assert.equal((await migration.query("q", 2)).length, 2);
	from.store.query = async () => [];
	assert.deepEqual(await migration.query("q", 2), []);
});

test("a bad hit from the compared side is reported as a failed comparison, not thrown", async () => {
	const { migration, to, events } = build({ phase: "compare" });
	to.store.query = async () => [{ id: "", score: 1 }];
	await migration.query("q", 1);
	assert.equal(events[0]?.type, "shadow_query_failed");
});

test("only the documented fields of a document reach the store", async () => {
	const { migration, to } = build();
	await migration.write([{ id: "a", version: 1, text: "ants", tenant: "secret" } as never]);
	assert.deepEqual(Object.keys(to.store.points.get("a") ?? {}).sort(), ["id", "text", "vector", "version"]);
});
