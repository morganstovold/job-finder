// Minimal D1 on top of bun:sqlite, enough for the worker's queries. Test-only.
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";

export function memoryD1() {
  const sqlite = new Database(":memory:");
  for (const f of readdirSync("migrations").toSorted()) sqlite.exec(readFileSync(`migrations/${f}`, "utf8"));
  const stmt = (sql: string, args: unknown[] = []): any => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    all: async () => ({ results: sqlite.query(sql).all(...(args as any[])) }),
    first: async () => sqlite.query(sql).get(...(args as any[])),
    run: async () => {
      const r = sqlite.query(sql).run(...(args as any[]));
      return { meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
    },
  });
  const DB = {
    prepare: (sql: string) => stmt(sql),
    // Like D1: runs in order, one result per statement (RETURNING rows land in `results`).
    batch: async (s: any[]) => {
      const out = [];
      for (const x of s) out.push(await x.all());
      return out;
    },
  };
  return { sqlite, DB };
}
