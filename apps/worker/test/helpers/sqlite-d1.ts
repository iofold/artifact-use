// A D1 stand-in backed by node:sqlite with every migration applied, for tests
// whose point is the SQL itself (joins, NULL handling, windows) rather than
// the call sequence a hand-written fake would encode.
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);

export function sqliteD1(): { db: D1Database; raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  for (const name of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort())
    raw.exec(readFileSync(new URL(name, MIGRATIONS), "utf8"));
  const db = {
    prepare(sql: string) {
      const stmt = raw.prepare(sql);
      let values: SQLInputValue[] = [];
      const statement = {
        bind(...args: unknown[]) {
          values = args as SQLInputValue[];
          return statement;
        },
        async first<T>() {
          return (stmt.get(...values) as T | undefined) ?? null;
        },
        async all<T>() {
          return { results: stmt.all(...values) as T[] };
        },
        async run() {
          const result = stmt.run(...values);
          return {
            meta: {
              changes: Number(result.changes),
              last_row_id: Number(result.lastInsertRowid),
            },
          };
        },
      };
      return statement;
    },
  };
  return { db: db as unknown as D1Database, raw };
}
