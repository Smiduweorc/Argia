// A reference VectorStore over Postgres with pgvector, used by the integration
// tests and quoted in the README. Not shipped: Argia owns no adapters.
import type pg from "pg";

import type { Deletion, Hit, Point, VectorStore } from "../../index.js";

export type Meta = { source: string };
export type Filter = { source?: string };

const literal = (vector: number[]): string => `[${vector.join(",")}]`;

// `table` comes from test code, never from input, so it is interpolated; every value goes through a parameter.
export async function pgvectorStore(pool: pg.Pool, table: string, dimensions: number): Promise<VectorStore<Meta, Filter>> {
	await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
	await pool.query(`CREATE TABLE IF NOT EXISTS ${table} (
		id text PRIMARY KEY,
		version double precision NOT NULL,
		deleted boolean NOT NULL,
		text text,
		metadata jsonb,
		embedding vector(${dimensions})
	)`);
	return {
		async upsert(points: Point<Meta>[]): Promise<void> {
			// One statement per batch, so the version check and the write are one atomic step per row.
			await pool.query(
				`INSERT INTO ${table} AS stored (id, version, deleted, text, metadata, embedding)
				SELECT id, version, false, text, metadata, embedding::vector
				FROM unnest($1::text[], $2::double precision[], $3::text[], $4::jsonb[], $5::text[]) AS t(id, version, text, metadata, embedding)
				ON CONFLICT (id) DO UPDATE SET
					version = excluded.version, deleted = false, text = excluded.text,
					metadata = excluded.metadata, embedding = excluded.embedding
				WHERE stored.version <= excluded.version`,
				[
					points.map((p) => p.id),
					points.map((p) => p.version),
					points.map((p) => p.text),
					points.map((p) => (p.metadata === undefined ? null : JSON.stringify(p.metadata))),
					points.map((p) => literal(p.vector)),
				],
			);
		},
		async query(vector: number[], k: number, filter: Filter | undefined): Promise<Hit<Meta>[]> {
			const { rows } = await pool.query<{ id: string; score: number; metadata: Meta | null }>(
				`SELECT id, 1 - (embedding <=> $1::vector) AS score, metadata
				FROM ${table}
				WHERE NOT deleted AND ($3::text IS NULL OR metadata->>'source' = $3)
				ORDER BY embedding <=> $1::vector
				LIMIT $2`,
				[literal(vector), k, filter?.source ?? null],
			);
			return rows.map((row) => (row.metadata === null ? { id: row.id, score: row.score } : { id: row.id, score: row.score, metadata: row.metadata }));
		},
		async delete(deletions: Deletion[]): Promise<void> {
			// A tombstone row: the same version rule then stops an older upsert from bringing it back.
			await pool.query(
				`INSERT INTO ${table} AS stored (id, version, deleted)
				SELECT id, version, true FROM unnest($1::text[], $2::double precision[]) AS t(id, version)
				ON CONFLICT (id) DO UPDATE SET
					version = excluded.version, deleted = true, text = NULL, metadata = NULL, embedding = NULL
				WHERE stored.version <= excluded.version`,
				[deletions.map((d) => d.id), deletions.map((d) => d.version)],
			);
		},
	};
}
