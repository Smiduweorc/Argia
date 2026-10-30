import { ArgiaError } from "./errors.js";
import { phases, route, type Phase, type Side } from "./route.js";

export interface Document<M> {
	readonly id: string;
	/**
	 * Orders writes to one id: a store keeps the higher version and ignores a
	 * lower one that arrives late. Use a revision counter or the source row's
	 * last-modified time in milliseconds, taken from where the text was read,
	 * so a backfill of an old copy cannot overwrite a newer live write.
	 */
	readonly version: number;
	readonly text: string;
	readonly metadata?: M;
}

/** A delete is versioned too, so a write older than the delete cannot bring the document back. */
export interface Deletion {
	readonly id: string;
	readonly version: number;
}

/** What a store is asked to keep: the document plus one profile's vector for it. */
export interface Point<M> extends Document<M> {
	readonly vector: number[];
}

/** What a store holds for one id: the version it kept, and whether that version is a tombstone. */
export interface StoredVersion {
	readonly version: number;
	readonly deleted: boolean;
}

/** One id whose two stores disagree, as {@link Migration.diff} reports it. `null` means the store has never seen the id. */
export interface Drift {
	readonly id: string;
	readonly from: StoredVersion | null;
	readonly to: StoredVersion | null;
}

export interface Hit<M> {
	readonly id: string;
	readonly score: number;
	readonly metadata?: M;
}

/**
 * The three things Argia needs from a vector database. Write the adapter for
 * yours; Argia ships none.
 *
 * Both writes must be conditional on version, atomically, or two writers can
 * leave the two stores holding different copies of one document. In Postgres
 * that is `INSERT ... ON CONFLICT (id) DO UPDATE ... WHERE stored.version <=
 * excluded.version`, with deletes kept as tombstone rows the same condition
 * applies to and queries skip.
 *
 * `F` is the filter your `query` accepts. Argia passes it through untouched,
 * so when the two stores are different databases, give both adapters one
 * filter shape and translate it inside each.
 */
export interface VectorStore<M, F = unknown> {
	/**
	 * Insert, or replace when the stored version (or tombstone) is not higher.
	 * An equal version replaces, so retrying a failed write is safe.
	 */
	upsert(points: Point<M>[]): Promise<void>;
	/** The `k` nearest points to `vector`, best first. `filter` is undefined when the caller gave none. */
	query(vector: number[], k: number, filter: F | undefined): Promise<Hit<M>[]>;
	/**
	 * Remove when the stored version is not higher, and remember the deletion
	 * so a later upsert at or below its version is ignored. Ids that do not
	 * exist are not an error.
	 */
	delete(deletions: Deletion[]): Promise<void>;
	/**
	 * Optional; needed only by {@link Migration.diff}. One entry per id, in the
	 * same order: the stored version and whether it is a tombstone, or `null`
	 * for an id the store has never seen (or whose tombstone was purged).
	 */
	versions?(ids: string[]): Promise<(StoredVersion | null)[]>;
}

/** One embedding model and the store that holds its vectors. */
export interface Profile<M, F = unknown> {
	/** Appears in errors and events. The two profiles must have different names. */
	readonly name: string;
	/** Length of every vector `embed` returns. Checked on every call. */
	readonly dimensions: number;
	/**
	 * One vector per text, in the same order. Receives every text of one
	 * `write` or `backfill` call at once, so split the call yourself if your
	 * provider caps the batch size.
	 */
	embed(texts: string[]): Promise<number[][]>;
	readonly store: VectorStore<M, F>;
}

export type MigrationEvent<M = unknown> =
	| {
		readonly type: "shadow_write_failed";
		readonly operation: "write" | "delete";
		readonly profile: string;
		readonly ids: readonly string[];
		readonly error: unknown;
	}
	| {
		readonly type: "shadow_query_failed";
		readonly profile: string;
		readonly text: string;
		readonly error: unknown;
	}
	| {
		readonly type: "compare";
		readonly text: string;
		readonly k: number;
		/** Hits returned by the `from` profile, best first. */
		readonly from: readonly Hit<M>[];
		/** Hits returned by the `to` profile, best first. Scores from two models are not on one scale. */
		readonly to: readonly Hit<M>[];
	};

export interface MigrationOptions<M, F = unknown> {
	/** The model and store you are moving away from. */
	readonly from: Profile<M, F>;
	/** The model and store you are moving to. */
	readonly to: Profile<M, F>;
	/** Where to start. Usually `from`, unless you are restarting a process mid-migration. */
	readonly phase: Phase;
	/**
	 * What a failed write or delete on the side not being read does. The side
	 * being read is written first, and its failure always throws without the
	 * other side being touched.
	 *
	 * `throw` rethrows the store's or model's error, so your ingestion retries
	 * and the two stores stay in step. `report` sends a `shadow_write_failed`
	 * event and lets the call succeed, so a broken new store cannot take down
	 * ingestion, at the cost of the new index missing those documents until
	 * you write them again.
	 */
	readonly shadowWriteFailure: "throw" | "report";
	/**
	 * How a dual write or delete reaches the two sides. `sequential` (the
	 * default) writes the read side first and the other side only if that
	 * succeeded, so a dual write takes as long as both together. `parallel`
	 * starts both at once and takes as long as the slower one; a write the read
	 * side refused may then still land on the other side. That is harmless
	 * under the version contract, since the call throws and your retry rewrites
	 * the same version, but the shadow can briefly hold a copy the read side
	 * does not. Failures are handled the same way in both modes.
	 */
	readonly writeOrder?: "sequential" | "parallel";
	/**
	 * Applied to the query text before it is put in a `compare` or
	 * `shadow_query_failed` event, so a listener never sees raw user input.
	 * Return `""` to drop it, or a hash to group repeats. If it throws, the
	 * event is not sent. Defaults to passing the text through unchanged.
	 */
	readonly redactText?: (text: string) => string;
	/**
	 * The fraction of queries in the `compare` phase that also query the other
	 * side, from 0 to 1. A compared query costs a second embedding call and a
	 * second store query, and waits for the slower of the two. 1 compares
	 * every query; pick lower when that doubles a bill or a latency budget you
	 * care about. Unused outside `compare`.
	 */
	readonly compareRate: number;
	/**
	 * Receives failures that were reported rather than thrown, and the results
	 * of every compared query. A listener that throws, or returns a promise
	 * that rejects, is ignored; an async listener is not awaited. Defaults to
	 * no listener.
	 */
	readonly onEvent?: (event: MigrationEvent<M>) => void;
	/** Source of randomness for `compareRate`, returning [0, 1). Defaults to `Math.random`. */
	readonly random?: () => number;
}

/**
 * Sends writes and reads to two embedding profiles according to the current
 * phase. One instance per process; the phase lives in memory, so every
 * process in a fleet must be moved separately. The README's "Running more than
 * one replica" section covers driving {@link Migration.setPhase} from a shared
 * flag or config store.
 */
export class Migration<M = unknown, F = unknown> {
	readonly #from: Profile<M, F>;
	readonly #to: Profile<M, F>;
	readonly #shadowWriteFailure: "throw" | "report";
	readonly #writeOrder: "sequential" | "parallel";
	readonly #redactText: ((text: string) => string) | undefined;
	readonly #compareRate: number;
	readonly #onEvent: ((event: MigrationEvent<M>) => void) | undefined;
	readonly #random: () => number;
	#phase: Phase;

	constructor(options: MigrationOptions<M, F>) {
		if (typeof options !== "object" || options === null) {
			throw new ArgiaError("invalid_options", "options are required");
		}
		checkProfile(options.from, "from");
		checkProfile(options.to, "to");
		if (options.from.name === options.to.name) {
			throw new ArgiaError("invalid_options", `both profiles are named "${options.from.name}"; give them different names`);
		}
		if (options.from.store === options.to.store) {
			throw new ArgiaError("invalid_options", "both profiles use the same store object; each model needs its own store or collection");
		}
		checkPhase(options.phase);
		if (options.shadowWriteFailure !== "throw" && options.shadowWriteFailure !== "report") {
			throw new ArgiaError("invalid_options", "shadowWriteFailure is required; pass \"throw\" or \"report\"");
		}
		if (options.writeOrder !== undefined && options.writeOrder !== "sequential" && options.writeOrder !== "parallel") {
			throw new ArgiaError("invalid_options", `writeOrder must be "sequential" or "parallel" (got ${String(options.writeOrder)})`);
		}
		if (options.redactText !== undefined && typeof options.redactText !== "function") {
			throw new ArgiaError("invalid_options", "redactText must be a function");
		}
		if (typeof options.compareRate !== "number" || !(options.compareRate >= 0 && options.compareRate <= 1)) {
			throw new ArgiaError("invalid_options", `compareRate is required and must be between 0 and 1 (got ${String(options.compareRate)}); pass 1 to compare every query`);
		}
		if (options.onEvent !== undefined && typeof options.onEvent !== "function") {
			throw new ArgiaError("invalid_options", "onEvent must be a function");
		}
		if (options.random !== undefined && typeof options.random !== "function") {
			throw new ArgiaError("invalid_options", "random must be a function");
		}
		this.#from = options.from;
		this.#to = options.to;
		this.#phase = options.phase;
		this.#shadowWriteFailure = options.shadowWriteFailure;
		this.#writeOrder = options.writeOrder ?? "sequential";
		this.#redactText = options.redactText;
		this.#compareRate = options.compareRate;
		this.#onEvent = options.onEvent;
		this.#random = options.random ?? Math.random;
	}

	get phase(): Phase {
		return this.#phase;
	}

	/** Takes effect for calls that start after it; calls already running keep the phase they started with. */
	setPhase(phase: Phase): void {
		checkPhase(phase);
		this.#phase = phase;
	}

	/**
	 * Embeds each document with every profile the phase writes to, and upserts
	 * the vectors. With the default `writeOrder`, the side being read goes
	 * first and the other side is written only if that succeeds, so it never
	 * holds a write the read side refused.
	 */
	async write(documents: readonly Document<M>[]): Promise<void> {
		const plan = route(this.#phase);
		checkEntries(documents, "write");
		if (documents.length === 0) {
			return;
		}
		await this.#inOrder("write", plan.read, plan.writes, documents.map((document) => document.id), (profile) => upsert(profile, documents));
	}

	/**
	 * Embeds and upserts into the `to` profile only, whatever the phase. Use it
	 * to fill the new index from your source documents without re-embedding
	 * everything the old index already holds. Every error throws: there is no
	 * shadow side here.
	 */
	async backfill(documents: readonly Document<M>[]): Promise<void> {
		checkEntries(documents, "write");
		if (documents.length === 0) {
			return;
		}
		await upsert(this.#to, documents);
	}

	/** Deletes from every store the phase writes to, the side being read first unless `writeOrder` is `parallel`. */
	async delete(deletions: readonly Deletion[]): Promise<void> {
		const plan = route(this.#phase);
		checkEntries(deletions, "delete");
		if (deletions.length === 0) {
			return;
		}
		await this.#inOrder("delete", plan.read, plan.writes, deletions.map((deletion) => deletion.id), (profile) => profile.store.delete([...deletions]));
	}

	/**
	 * Returns the `k` nearest documents from the profile the phase reads,
	 * passing `filter` to its store. In `compare`, a `compareRate` share of
	 * queries also run against the other profile with the same filter, and
	 * those calls wait for both.
	 */
	async query(text: string, k: number, filter?: F): Promise<Hit<M>[]> {
		if (!Number.isInteger(k) || k < 1) {
			throw new ArgiaError("invalid_k", `k must be a positive integer (got ${String(k)})`);
		}
		const plan = route(this.#phase);
		const reader = this.#profile(plan.read);
		if (!plan.compare || !this.#sampled()) {
			return search(reader, text, k, filter);
		}
		const other = this.#profile(plan.read === "from" ? "to" : "from");
		const [primary, shadow] = await Promise.allSettled([search(reader, text, k, filter), search(other, text, k, filter)]);
		if (primary.status === "rejected") {
			throw primary.reason;
		}
		if (shadow.status === "rejected") {
			this.#emitWithText(text, (shown) => ({ type: "shadow_query_failed", profile: other.name, text: shown, error: shadow.reason }));
		} else {
			const [fromHits, toHits] = plan.read === "from" ? [primary.value, shadow.value] : [shadow.value, primary.value];
			this.#emitWithText(text, (shown) => ({ type: "compare", text: shown, k, from: fromHits, to: toHits }));
		}
		return primary.value;
	}

	/**
	 * Asks both stores what they hold for each id and returns the ids where
	 * they disagree: a different version, or one side deleted and the other
	 * not. Use it to find what a reported shadow failure left behind, then
	 * `write` (or `delete`) those ids again from your source; the version rule
	 * makes rewriting a copy a store already has harmless.
	 *
	 * Pass ids in batches your stores can answer in one call. Both stores need
	 * `versions`. The result is a snapshot: a write running at the same time
	 * can show up as drift that is gone a moment later, so check again before
	 * acting on a short list. After `to-only` the old store stops receiving
	 * writes, so drift there is expected.
	 */
	async diff(ids: readonly string[]): Promise<Drift[]> {
		checkEntries(ids.map((id) => ({ id, version: 0 })), "diff");
		for (const profile of [this.#from, this.#to]) {
			if (typeof profile.store.versions !== "function") {
				throw new ArgiaError("unsupported_store", `profile "${profile.name}" store has no versions method; diff needs it on both stores`, { profile: profile.name });
			}
		}
		if (ids.length === 0) {
			return [];
		}
		const [fromVersions, toVersions] = await Promise.all([versions(this.#from, ids), versions(this.#to, ids)]);
		const drift: Drift[] = [];
		ids.forEach((id, i) => {
			const from = fromVersions[i] as StoredVersion | null;
			const to = toVersions[i] as StoredVersion | null;
			if (from?.version !== to?.version || from?.deleted !== to?.deleted) {
				drift.push({ id, from, to });
			}
		});
		return drift;
	}

	async #inOrder(operation: "write" | "delete", read: Side, sides: readonly Side[], ids: readonly string[], run: (profile: Profile<M, F>) => Promise<void>): Promise<void> {
		const shadows = sides.filter((side) => side !== read).map((side) => this.#profile(side));
		const fail = (profile: Profile<M, F>, error: unknown): void => {
			this.#emit({ type: "shadow_write_failed", operation, profile: profile.name, ids: [...ids], error });
		};
		if (this.#writeOrder === "parallel") {
			const [primary, ...rest] = await Promise.allSettled([sides.includes(read) ? run(this.#profile(read)) : Promise.resolve(), ...shadows.map(run)]);
			// Every shadow failure is reported, even when the read side's failure is the one thrown.
			let rethrow: { error: unknown } | undefined;
			rest.forEach((result, i) => {
				if (result.status === "rejected") {
					fail(shadows[i] as Profile<M, F>, result.reason);
					rethrow ??= { error: result.reason };
				}
			});
			if (primary?.status === "rejected") {
				throw primary.reason;
			}
			if (rethrow !== undefined && this.#shadowWriteFailure === "throw") {
				throw rethrow.error;
			}
			return;
		}
		if (sides.includes(read)) {
			await run(this.#profile(read));
		}
		for (const profile of shadows) {
			try {
				await run(profile);
			} catch (error) {
				fail(profile, error);
				if (this.#shadowWriteFailure === "throw") {
					throw error;
				}
			}
		}
	}

	#emitWithText(text: string, build: (shown: string) => MigrationEvent<M>): void {
		let shown = text;
		if (this.#redactText !== undefined) {
			try {
				shown = String(this.#redactText(text));
			} catch {
				// Sending the raw text would defeat the redaction, so the event is dropped instead.
				return;
			}
		}
		this.#emit(build(shown));
	}

	#sampled(): boolean {
		const draw = this.#random();
		if (typeof draw !== "number" || !(draw >= 0 && draw < 1)) {
			throw new ArgiaError("invalid_options", `random must return a number in [0, 1) (got ${String(draw)})`);
		}
		return draw < this.#compareRate;
	}

	#profile(side: Side): Profile<M, F> {
		return side === "from" ? this.#from : this.#to;
	}

	#emit(event: MigrationEvent<M>): void {
		if (this.#onEvent === undefined) {
			return;
		}
		// A broken listener must not turn a successful call into a failed one.
		try {
			const result: unknown = this.#onEvent(event);
			if (typeof (result as PromiseLike<unknown> | undefined)?.then === "function") {
				// Intentionally not awaited: an async listener must not slow the call down, only lose its rejection.
				Promise.resolve(result).catch(() => {});
			}
		} catch {
			// Ignored for the same reason.
		}
	}
}

// One id twice in a call would leave the outcome to the store's batch order, so it is refused for deletes as well as writes.
function checkEntries(entries: readonly { readonly id: string; readonly version: number }[], operation: "write" | "delete" | "diff"): void {
	const seen = new Set<string>();
	for (const entry of entries) {
		if (typeof entry.id !== "string" || entry.id === "") {
			throw new ArgiaError("invalid_id", "document ids must be non-empty strings", { documentId: String(entry.id) });
		}
		if (seen.has(entry.id)) {
			throw new ArgiaError("duplicate_id", `document "${entry.id}" appears twice in one ${operation}`, { documentId: entry.id });
		}
		if (typeof entry.version !== "number" || !Number.isFinite(entry.version) || entry.version < 0) {
			throw new ArgiaError("invalid_version", `document "${entry.id}" needs a finite, non-negative version (got ${String(entry.version)})`, { documentId: entry.id });
		}
		seen.add(entry.id);
	}
}

async function upsert<M, F>(profile: Profile<M, F>, documents: readonly Document<M>[]): Promise<void> {
	const vectors = await embed(profile, documents.map((document) => document.text));
	// Only the documented fields reach the store, so an adapter cannot come to depend on extras a caller happened to pass.
	await profile.store.upsert(documents.map(({ id, version, text, metadata }, i) =>
		(metadata === undefined ? { id, version, text, vector: vectors[i] as number[] } : { id, version, text, metadata, vector: vectors[i] as number[] })));
}

async function embed<M, F>(profile: Profile<M, F>, texts: string[]): Promise<number[][]> {
	const vectors = await profile.embed(texts);
	if (!Array.isArray(vectors) || vectors.length !== texts.length) {
		const got = Array.isArray(vectors) ? vectors.length : 0;
		throw new ArgiaError("embedding_count_mismatch", `profile "${profile.name}" returned ${got} embeddings for ${texts.length} texts`, { profile: profile.name });
	}
	for (const vector of vectors) {
		if (!Array.isArray(vector) || vector.length !== profile.dimensions) {
			const got = Array.isArray(vector) ? vector.length : 0;
			throw new ArgiaError("embedding_dimension_mismatch", `profile "${profile.name}" returned a vector of length ${got}; its dimensions are ${profile.dimensions}`, { profile: profile.name });
		}
		if (!vector.every(Number.isFinite)) {
			throw new ArgiaError("embedding_not_finite", `profile "${profile.name}" returned a vector containing NaN or Infinity`, { profile: profile.name });
		}
	}
	return vectors;
}

async function versions<M, F>(profile: Profile<M, F>, ids: readonly string[]): Promise<(StoredVersion | null)[]> {
	const result: unknown = await (profile.store.versions as NonNullable<VectorStore<M, F>["versions"]>)([...ids]);
	if (!Array.isArray(result) || result.length !== ids.length) {
		const got = Array.isArray(result) ? `${result.length} entries` : typeof result;
		throw new ArgiaError("invalid_store_result", `profile "${profile.name}" store returned ${got} from versions for ${ids.length} ids`, { profile: profile.name });
	}
	for (const entry of result as Partial<StoredVersion>[] | null[]) {
		if (entry !== null && (typeof entry?.version !== "number" || !Number.isFinite(entry.version) || typeof entry.deleted !== "boolean")) {
			throw new ArgiaError("invalid_store_result", `profile "${profile.name}" store returned a versions entry that is neither null nor { version, deleted }: ${JSON.stringify(entry)}`, { profile: profile.name });
		}
	}
	return result as (StoredVersion | null)[];
}

async function search<M, F>(profile: Profile<M, F>, text: string, k: number, filter: F | undefined): Promise<Hit<M>[]> {
	const [vector] = await embed(profile, [text]);
	const hits: unknown = await profile.store.query(vector as number[], k, filter);
	if (!Array.isArray(hits)) {
		throw new ArgiaError("invalid_store_result", `profile "${profile.name}" store returned ${typeof hits} from query; expected an array of hits`, { profile: profile.name });
	}
	if (hits.length > k) {
		throw new ArgiaError("invalid_store_result", `profile "${profile.name}" store returned ${hits.length} hits for k = ${k}`, { profile: profile.name });
	}
	for (const hit of hits as Partial<Hit<M>>[]) {
		if (typeof hit?.id !== "string" || hit.id === "" || typeof hit.score !== "number" || !Number.isFinite(hit.score)) {
			throw new ArgiaError("invalid_store_result", `profile "${profile.name}" store returned a hit without a non-empty string id and a finite score: ${JSON.stringify(hit)}`, { profile: profile.name });
		}
	}
	return hits as Hit<M>[];
}

function checkProfile<M, F>(profile: Profile<M, F>, label: Side): void {
	if (typeof profile !== "object" || profile === null) {
		throw new ArgiaError("invalid_options", `${label} is required; pass the profile you are migrating ${label}`);
	}
	if (typeof profile.name !== "string" || profile.name === "") {
		throw new ArgiaError("invalid_options", `${label}.name must be a non-empty string`);
	}
	if (!Number.isInteger(profile.dimensions) || profile.dimensions < 1) {
		throw new ArgiaError("invalid_options", `${label}.dimensions must be a positive integer (got ${String(profile.dimensions)})`);
	}
	if (typeof profile.embed !== "function") {
		throw new ArgiaError("invalid_options", `${label}.embed must be a function`);
	}
	const store = profile.store;
	if (typeof store !== "object" || store === null
		|| typeof store.upsert !== "function" || typeof store.query !== "function" || typeof store.delete !== "function") {
		throw new ArgiaError("invalid_options", `${label}.store must have upsert, query and delete methods`);
	}
}

function checkPhase(phase: Phase): void {
	if (!phases.includes(phase)) {
		throw new ArgiaError("invalid_phase", `unknown phase "${String(phase)}"; use one of ${phases.join(", ")}`);
	}
}
