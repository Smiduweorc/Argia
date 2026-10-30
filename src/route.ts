export type Side = "from" | "to";

/** Moved only by {@link Migration.setPhase}, in either direction. */
export type Phase = "from" | "compare" | "to" | "to-only";

export const phases: readonly Phase[] = ["from", "compare", "to", "to-only"];

export interface Route {
	/** The side whose results a query returns, and whose write failures always throw. */
	readonly read: Side;
	readonly writes: readonly Side[];
	/** Whether queries may also run against the other side, at `compareRate`. */
	readonly compare: boolean;
}

/**
 * The whole policy for one phase.
 *
 * | phase     | writes go to | queries read | other side queried |
 * | --------- | ------------ | ------------ | ------------------ |
 * | `from`    | from, to     | from         | no                 |
 * | `compare` | from, to     | from         | at `compareRate`   |
 * | `to`      | from, to     | to           | no                 |
 * | `to-only` | to           | to           | no                 |
 *
 * `to` keeps writing to the old side so moving back to `compare` or `from`
 * loses nothing. `to-only` is the point of no return: from then on the old
 * store stops receiving writes and deletes.
 */
export function route(phase: Phase): Route {
	switch (phase) {
	case "from":
		return { read: "from", writes: ["from", "to"], compare: false };
	case "compare":
		return { read: "from", writes: ["from", "to"], compare: true };
	case "to":
		return { read: "to", writes: ["from", "to"], compare: false };
	case "to-only":
		return { read: "to", writes: ["to"], compare: false };
	}
}
