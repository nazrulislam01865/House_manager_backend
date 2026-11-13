import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
export type Transaction = PoolClient;
@Injectable()
export class Database implements OnModuleDestroy {
 readonly pool: Pool;

  constructor() {
    const ca = process.env.SUPABASE_DB_CA_CERT;

    if (!ca) {
      throw new Error("SUPABASE_DB_CA_CERT is required");
    }

    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.DB_POOL_SIZE || 2),
      statement_timeout: 10000,
      connectionTimeoutMillis: 5000,
      ssl: {
        ca: ca.replace(/\\n/g, "\n"),
        rejectUnauthorized: true,
      },
    });
  }
  async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ) {
    return (await this.pool.query<T>(sql, params)).rows;
  }
  async tx<T>(work: (client: Transaction) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const result = await work(c);
      await c.query("COMMIT");
      return result;
    } catch (error) {
      await c.query("ROLLBACK");
      throw error;
    } finally {
      c.release();
    }
  }
  async onModuleDestroy() {
    await this.pool.end();
  }
}
