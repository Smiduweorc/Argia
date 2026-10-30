import { test } from "node:test";
import assert from "node:assert/strict";

import { route } from "../src/route.js";

test("from: writes to both, reads from, no comparison", () => {
	assert.deepEqual(route("from"), { read: "from", writes: ["from", "to"], compare: false });
});

test("compare: writes to both, reads from, compares against to", () => {
	assert.deepEqual(route("compare"), { read: "from", writes: ["from", "to"], compare: true });
});

test("to: writes to both so a rollback loses nothing, reads to", () => {
	assert.deepEqual(route("to"), { read: "to", writes: ["from", "to"], compare: false });
});

test("to-only: the old store receives nothing", () => {
	assert.deepEqual(route("to-only"), { read: "to", writes: ["to"], compare: false });
});
