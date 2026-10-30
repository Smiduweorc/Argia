import type { Hit } from "./migration.js";

/** How far two hit lists for one query agree, by id and rank. Scores are ignored: two models' scores are not on one scale. */
export interface Overlap {
	/** Ids present in both lists. */
	readonly shared: number;
	/**
	 * The share of the `from` hits that the `to` list also returned, from 0 to
	 * 1. Reads as "how much of what users get today would they still get". 1
	 * when `from` is empty.
	 */
	readonly recall: number;
	/** Whether both lists put the same id first. True when both are empty. */
	readonly topMatch: boolean;
	/**
	 * Rank-biased overlap at the depth of the longer list, from 0 to 1, with
	 * persistence 0.9: agreement near the top counts for more than agreement
	 * near the bottom. 1 means the same ids in the same order; both empty is 1.
	 */
	readonly rankOverlap: number;
}

/**
 * A starting point for deciding readiness from `compare` events, not a
 * verdict: which threshold means "ready" is still yours. Duplicate ids within
 * one list are counted once, at their first rank.
 *
 * @example
 * onEvent: (event) => {
 * 	if (event.type === "compare") {
 * 		const { recall, rankOverlap } = overlap(event.from, event.to);
 * 		metrics.observe("argia.recall", recall);
 * 		metrics.observe("argia.rank_overlap", rankOverlap);
 * 	}
 * }
 */
export function overlap<M>(from: readonly Hit<M>[], to: readonly Hit<M>[]): Overlap {
	const a = unique(from);
	const b = unique(to);
	const inB = new Set(b);
	const shared = a.filter((id) => inB.has(id)).length;
	const depth = Math.max(a.length, b.length);
	let rankOverlap = 1;
	if (depth > 0) {
		// Truncated RBO, normalised by its own maximum so identical lists of any length score exactly 1.
		const p = 0.9;
		const seenA = new Set<string>();
		const seenB = new Set<string>();
		let common = 0;
		let sum = 0;
		let max = 0;
		for (let d = 1; d <= depth; d++) {
			const x = a[d - 1];
			const y = b[d - 1];
			if (x !== undefined) {
				if (seenB.has(x)) common++;
				seenA.add(x);
			}
			if (y !== undefined) {
				if (seenA.has(y)) common++;
				seenB.add(y);
			}
			const weight = p ** (d - 1);
			sum += weight * (common / d);
			max += weight;
		}
		rankOverlap = sum / max;
	}
	return {
		shared,
		recall: a.length === 0 ? 1 : shared / a.length,
		topMatch: a[0] === b[0],
		rankOverlap,
	};
}

function unique<M>(hits: readonly Hit<M>[]): string[] {
	return [...new Set(hits.map((hit) => hit.id))];
}
