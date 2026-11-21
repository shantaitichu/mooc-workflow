import { DatabaseSync } from 'node:sqlite';
import { Pool, type PoolClient } from 'pg';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
export interface Connection {
  query<T = any>(sql: string, values?: unknown[]): Promise<T[]>;
  exec(sql: string, values?: unknown[]): Promise<void>;
}
export class Database implements Connection {
  private sqlite?: DatabaseSync;
  private pool?: Pool;
  private tail: Promise<unknown> = Promise.resolve();
  readonly postgres: boolean;
  constructor(location: string) {
    this.postgres = /^postgres(ql)?:/.test(location);
    if (this.postgres) this.pool = new Pool({ connectionString: location });
    else {
      if (location !== ':memory:') mkdirSync(path.dirname(location), { recursive: true });
      this.sqlite = new DatabaseSync(location);
      this.sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    }
  }
  async query<T = any>(sql: string, values: unknown[] = []): Promise<T[]> {
    if (this.pool) return (await this.pool.query(sql, values)).rows;
    const params: unknown[] = [];
    const statement = sql.replace(/\$(\d+)/g, (_, n) => {
      params.push(values[+n - 1]);
      return '?';
    });
    return this.sqlite!.prepare(statement).all(...(params as any[])) as T[];
  }
  async exec(sql: string, values: unknown[] = []): Promise<void> {
    if (this.pool) {
      await this.pool.query(sql, values);
      return;
    }
    const params: unknown[] = [];
    const statement = sql.replace(/\$(\d+)/g, (_, n) => {
      params.push(values[+n - 1]);
      return '?';
    });
    this.sqlite!.prepare(statement).run(...(params as any[]));
  }
  async transaction<T>(action: (connection: Connection) => Promise<T>): Promise<T> {
    if (this.pool) {
      const client: PoolClient = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const result = await action({
          query: async (s, v) => (await client.query(s, v)).rows,
          exec: async (s, v) => {
            await client.query(s, v);
          },
        });
        await client.query('COMMIT');
        return result;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    }
    const run = async () => {
      this.sqlite!.exec('BEGIN IMMEDIATE');
      try {
        const result = await action(this);
        this.sqlite!.exec('COMMIT');
        return result;
      } catch (e) {
        this.sqlite!.exec('ROLLBACK');
        throw e;
      }
    };
    const next = this.tail.then(run, run);
    this.tail = next.catch(() => {});
    return next;
  }
  async initialize() {
    for (const sql of [
      `CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, organization_id TEXT NOT NULL, role TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS wallets(organization_id TEXT PRIMARY KEY, available BIGINT NOT NULL CHECK(available>=0), frozen BIGINT NOT NULL CHECK(frozen>=0), spent BIGINT NOT NULL CHECK(spent>=0))`,
      `CREATE TABLE IF NOT EXISTS quotes(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,input TEXT NOT NULL,cost BIGINT NOT NULL,expires_at TEXT NOT NULL,pricing_version TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,organization_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,quote_id TEXT NOT NULL UNIQUE,input TEXT NOT NULL,status TEXT NOT NULL,cost BIGINT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,provider_id TEXT,output_asset_id TEXT,voice_id TEXT,error TEXT,cancel_requested INTEGER NOT NULL DEFAULT 0,UNIQUE(user_id,idempotency_key))`,
      `CREATE TABLE IF NOT EXISTS ledger(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,user_id TEXT NOT NULL,job_id TEXT,type TEXT NOT NULL,amount BIGINT NOT NULL,created_at TEXT NOT NULL,description TEXT NOT NULL,UNIQUE(job_id,type))`,
      `CREATE TABLE IF NOT EXISTS grants(key TEXT PRIMARY KEY,organization_id TEXT NOT NULL,amount BIGINT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS objects(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,name TEXT NOT NULL,mime TEXT NOT NULL,sha256 TEXT,size BIGINT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,purpose TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS voices(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,model TEXT NOT NULL,provider_id TEXT NOT NULL,created_at TEXT NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status,created_at)`,
      `CREATE INDEX IF NOT EXISTS objects_expiry ON objects(expires_at)`,
    ])
      await this.exec(sql);
  }
  async close() {
    await this.tail;
    this.sqlite?.close();
    await this.pool?.end();
  }
}
