// The `.js` extension is required: under `nodenext` resolution the specifier
// must match the emitted file, not the `.ts` source.

export { Migration } from "./src/migration.js";
export { ArgiaError } from "./src/errors.js";

export type { Deletion, Document, Hit, MigrationEvent, MigrationOptions, Point, Profile, VectorStore } from "./src/migration.js";
export type { ArgiaErrorCode } from "./src/errors.js";
export type { Phase } from "./src/route.js";
