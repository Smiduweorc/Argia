export type ArgiaErrorCode =
	| "invalid_options"
	| "invalid_phase"
	| "invalid_id"
	| "duplicate_id"
	| "invalid_version"
	| "invalid_k"
	| "embedding_count_mismatch"
	| "embedding_dimension_mismatch"
	| "embedding_not_finite"
	| "invalid_store_result"
	| "nonconformant_store";

/**
 * Argia's own refusals. An error thrown by your embed function or your store
 * is never wrapped in this; it reaches you unchanged.
 */
export class ArgiaError extends Error {
	override readonly name = "ArgiaError";
	readonly code: ArgiaErrorCode;
	/** The profile whose output was refused, for the embedding codes and `invalid_store_result`. */
	readonly profile: string | undefined;
	/** The offending document id, for `invalid_id`, `duplicate_id` and `invalid_version`. */
	readonly documentId: string | undefined;
	/** One line per failed check, for `nonconformant_store`. */
	readonly failures: readonly string[];

	constructor(code: ArgiaErrorCode, message: string, ids: { profile?: string; documentId?: string; failures?: readonly string[] } = {}) {
		super(`argia: ${message}`);
		this.code = code;
		this.profile = ids.profile;
		this.documentId = ids.documentId;
		this.failures = ids.failures ?? [];
	}
}
