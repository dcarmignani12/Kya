import pg from "pg";
import { requireEnv } from "./env.server";

// Return DATE columns as plain "YYYY-MM-DD" strings (no timezone shifts).
pg.types.setTypeParser(1082, (v: string) => v);

const globalForPool = globalThis as unknown as { __agenttripPool?: pg.Pool };

export function db(): pg.Pool {
  if (!globalForPool.__agenttripPool) {
    globalForPool.__agenttripPool = new pg.Pool({ connectionString: requireEnv("DATABASE_URL"), max: 10 });
  }
  return globalForPool.__agenttripPool;
}

export async function withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
