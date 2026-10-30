// Imports the built package by its own name, so a broken exports map or a
// missing .js specifier fails here rather than in someone's install.
import { test } from "node:test";
import assert from "node:assert/strict";

import * as argia from "argia-migrator";

test("the built package exports exactly Migration and ArgiaError", () => {
	assert.deepEqual(Object.keys(argia).sort(), ["ArgiaError", "Migration"]);
});

test("the built Migration routes a write to both profiles", async () => {
	const stored = { from: [], to: [] };
	const profile = (name) => ({
		name,
		dimensions: 1,
		embed: async (texts) => texts.map(() => [1]),
		store: {
			upsert: async (points) => { stored[name].push(...points.map((p) => p.id)); },
			query: async () => [],
			delete: async () => {},
		},
	});
	const migration = new argia.Migration({ from: profile("from"), to: profile("to"), phase: "from", shadowWriteFailure: "throw", compareRate: 1 });
	await migration.write([{ id: "a", version: 1, text: "ants" }]);
	assert.deepEqual(stored, { from: ["a"], to: ["a"] });
	await assert.rejects(migration.query("q", 0), (error) => error instanceof argia.ArgiaError && error.code === "invalid_k");
});

test("the built conformance subpath exports checkVectorStore and nothing else", async () => {
	const conformance = await import("argia-migrator/conformance");
	assert.deepEqual(Object.keys(conformance), ["checkVectorStore"]);
	await assert.rejects(conformance.checkVectorStore({}), (error) => error instanceof argia.ArgiaError && error.code === "invalid_options");
});
