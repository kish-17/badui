/**
 * @brake/supabase — the Supabase (Postgres + PostgREST + Auth) implementation
 * of BRAKE's persistence port, isolated per user by row-level security.
 * The schema itself lives in supabase/migrations.
 */
export { createSupabaseStore, SupabaseStoreError, ID_FILTER_BATCH_SIZE, WRITE_BATCH_SIZE } from "./store";
export type { SupabaseStoreOptions } from "./store";
export type { Database, Json, Tables, TablesInsert, TablesUpdate } from "./database.types";
export * from "./rows";
