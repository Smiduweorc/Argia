import { ArgiaError } from "./errors.js";
import type { Hit, VectorStore } from "./migration.js";

export interface ConformanceOptions<M, F> {
	/** The adapter under test. Point it at an empty scratch table or collection: the check writes, deletes and leaves tombstones behind. */
	readonly store: VectorStore<M, F>;
	/** Vector length the store accepts. */
	readonly dimensions: number;
	/** Prefix for every id the check writes, so its rows are recognisable in the scratch store. */
	readonly idPrefix: string;
	/**
	 * Builds the metadata for a test point from a label. The store must return
	 * it unchanged in `Hit.metadata`; that is how the check tells which version
	 * a store kept.
	 */
	readonly metadata: (label: string) => M;
	/** Passed to every `query`. Omit when the store needs none. */
	readonly filter?: F;
}

/**
 * Runs the {@link VectorStore} version contract against a real store and
 * throws `nonconformant_store` listing every check that failed. An error the
 * store itself throws is rethrown unchanged.
 *
 * | check                  | what it writes                                  | expects            |
 * | ---------------------- | ----------------------------------------------- | ------------------ |
 * | `stale-write`          | v2, then v1                                     | v2 kept            |
 * | `equal-version`        | v1, then v1 with other metadata                 | the second kept    |
 * | `delete`               | v1, then delete v2                              | gone from queries  |
 * | `write-after-delete`   | v1, delete v3, then v2                          | still gone         |
 * | `write-at-delete`      | v1, delete v3, then v3                          | back, v3 kept      |
 * | `concurrent-writes`    | v20 down to v1, all at once                     | v20 kept           |
 * | `concurrent-delete`    | v1, then delete v3 and write v2 at once         | gone               |
 * | `delete-missing`       | delete of an id never written                   | no error           |
 *
 * Every point shares one vector and queries ask for 10 hits, so a store
 * holding other rows with that exact vector can push the test rows out.
 */
export async function checkVectorStore<M, F = unknown>(options: ConformanceOptions<M, F>): Promise<void> {
	if (typeof options !== "object" || options === null) {
		throw new ArgiaError("invalid_options", "options are required");
	}
	const { store, dimensions, idPrefix, metadata, filter } = options;
	if (typeof store !== "object" || store === null
		|| typeof store.upsert !== "function" || typeof store.query !== "function" || typeof store.delete !== "function") {
		throw new ArgiaError("invalid_options", "store must have upsert, query and delete methods");
	}
	if (!Number.isInteger(dimensions) || dimensions < 1) {
		throw new ArgiaError("invalid_options", `dimensions must be a positive integer (got ${String(dimensions)})`);
	}
	if (typeof idPrefix !== "string" || idPrefix === "") {
		throw new ArgiaError("invalid_options", "idPrefix is required; pass a prefix no real document id starts with");
	}
	if (typeof metadata !== "function") {
		throw new ArgiaError("invalid_options", "metadata must be a function from a label to your metadata shape");
	}

	const vector = Array.from({ length: dimensions }, (_, i) => (i === 0 ? 1 : 0));
	const point = (id: string, version: number, label: string): Parameters<VectorStore<M, F>["upsert"]>[0][number] =>
		({ id, version, text: label, metadata: metadata(label), vector });
	const find = async (id: string): Promise<Hit<M> | undefined> =>
		(await store.query(vector, 10, filter)).find((hit) => hit.id === id);
	const failures: string[] = [];
	const kept = async (check: string, id: string, label: string): Promise<void> => {
		const hit = await find(id);
		if (hit === undefined) {
			failures.push(`${check}: "${id}" is missing from query results; expected the copy labelled "${label}"`);
		} else if (!sameMetadata(hit.metadata, metadata(label))) {
			failures.push(`${check}: "${id}" came back with ${JSON.stringify(hit.metadata)}; expected ${JSON.stringify(metadata(label))}`);
		}
	};
	const gone = async (check: string, id: string): Promise<void> => {
		if (await find(id) !== undefined) {
			failures.push(`${check}: "${id}" is still returned by query after a newer delete`);
		}
	};
	const id = (check: string): string => `${idPrefix}-${check}`;

	await store.upsert([point(id("stale-write"), 2, "v2")]);
	await store.upsert([point(id("stale-write"), 1, "v1")]);
	await kept("stale-write", id("stale-write"), "v2");

	await store.upsert([point(id("equal-version"), 1, "v1")]);
	await store.upsert([point(id("equal-version"), 1, "v1-retry")]);
	await kept("equal-version", id("equal-version"), "v1-retry");

	await store.upsert([point(id("delete"), 1, "v1")]);
	await store.delete([{ id: id("delete"), version: 2 }]);
	await gone("delete", id("delete"));

	await store.upsert([point(id("write-after-delete"), 1, "v1")]);
	await store.delete([{ id: id("write-after-delete"), version: 3 }]);
	await store.upsert([point(id("write-after-delete"), 2, "v2")]);
	await gone("write-after-delete", id("write-after-delete"));

	await store.upsert([point(id("write-at-delete"), 1, "v1")]);
	await store.delete([{ id: id("write-at-delete"), version: 3 }]);
	await store.upsert([point(id("write-at-delete"), 3, "v3")]);
	await kept("write-at-delete", id("write-at-delete"), "v3");

	// Highest first: a store that reads the stored version and writes in two steps lets the last arrival win.
	const versions = Array.from({ length: 20 }, (_, i) => 20 - i);
	await Promise.all(versions.map((version) => store.upsert([point(id("concurrent-writes"), version, `v${version}`)])));
	await kept("concurrent-writes", id("concurrent-writes"), "v20");

	await store.upsert([point(id("concurrent-delete"), 1, "v1")]);
	await Promise.all([
		store.delete([{ id: id("concurrent-delete"), version: 3 }]),
		store.upsert([point(id("concurrent-delete"), 2, "v2")]),
	]);
	await gone("concurrent-delete", id("concurrent-delete"));

	await store.delete([{ id: id("delete-missing"), version: 1 }]);

	if (failures.length > 0) {
		throw new ArgiaError("nonconformant_store", `the store breaks the version contract:\n${failures.join("\n")}`, { failures });
	}
}

// Stores hand metadata back after a round trip through their own serialisation, so key order is not significant.
function sameMetadata(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) {
		return true;
	}
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) {
		return false;
	}
	const aKeys = Object.keys(a);
	const bKeys = Object.keys(b);
	return aKeys.length === bKeys.length
		&& aKeys.every((key) => Object.hasOwn(b, key) && sameMetadata((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}
