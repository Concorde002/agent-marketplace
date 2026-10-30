import type pg from "pg";
import type { Queryable } from "../payments/postgres-store.js";

export interface Database extends Queryable {
  transaction<T>(action: (db: Queryable) => Promise<T>): Promise<T>;
}

export class PlatformError extends Error {
  constructor(readonly status: number, readonly code: string, message = code) { super(message); }
}

/** Each transaction uses one checked-out connection, never BEGIN on the shared pool. */
export function postgresDatabase(pool: pg.Pool): Database {
  return {
    async query<R = Record<string, unknown>>(sql: string, params?: unknown[]) {
      const result = await pool.query(sql, params);
      return { rows: result.rows as R[] };
    },
    async transaction<T>(action: (db: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("set local statement_timeout = '10s'");
        const result = await action(client);
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      } finally { client.release(); }
    },
  };
}
