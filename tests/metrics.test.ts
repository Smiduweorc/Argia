import { test } from "node:test";
import assert from "node:assert/strict";

import { overlap } from "../index.js";

const hits = (...ids: string[]): { id: string; score: number }[] => ids.map((id, i) => ({ id, score: 1 - i / 10 }));

test("identical lists score 1 everywhere", () => {
	assert.deepEqual(overlap(hits("a", "b", "c"), hits("a", "b", "c")), { shared: 3, recall: 1, topMatch: true, rankOverlap: 1 });
});

test("disjoint lists score 0", () => {
	assert.deepEqual(overlap(hits("a", "b"), hits("c", "d")), { shared: 0, recall: 0, topMatch: false, rankOverlap: 0 });
});

test("two empty lists agree, and an empty from list has nothing to lose", () => {
	assert.deepEqual(overlap([], []), { shared: 0, recall: 1, topMatch: true, rankOverlap: 1 });
	assert.equal(overlap([], hits("a")).recall, 1);
	assert.equal(overlap(hits("a"), []).recall, 0);
});

test("recall counts the from hits the to list kept, ignoring order and scores", () => {
	const result = overlap(hits("a", "b", "c", "d"), hits("d", "x", "b", "y"));
	assert.equal(result.shared, 2);
	assert.equal(result.recall, 0.5);
	assert.equal(result.topMatch, false);
});

test("rank overlap rewards agreement near the top over agreement near the bottom", () => {
	const swappedTop = overlap(hits("a", "b", "c", "d", "e"), hits("b", "a", "c", "d", "e")).rankOverlap;
	const swappedBottom = overlap(hits("a", "b", "c", "d", "e"), hits("a", "b", "c", "e", "d")).rankOverlap;
	assert.ok(swappedTop < swappedBottom);
	assert.ok(swappedBottom < 1);
	assert.ok(swappedTop > 0);
});

test("duplicate ids count once, at their first rank", () => {
	assert.deepEqual(overlap(hits("a", "a", "b"), hits("a", "b")), { shared: 2, recall: 1, topMatch: true, rankOverlap: 1 });
});
