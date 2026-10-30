// The `.js` extension is required: under `nodenext` resolution the specifier
// must match the emitted file, not the `.ts` source.

export { Migration } from "./src/migration.js";
export { ArgiaError } from "./src/errors.js";
export { overlap } from "./src/metrics.js";

export type { Deletion, Document, Drift, Hit, MigrationEvent, MigrationOptions, Point, Profile, StoredVersion, VectorStore } from "./src/migration.js";
export type { ArgiaErrorCode } from "./src/errors.js";
export type { Overlap } from "./src/metrics.js";
export type { Phase } from "./src/route.js";
