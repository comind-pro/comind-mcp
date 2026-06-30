import pg from 'pg';
import type { CallResult, Connector, HealthResult, SourceObject, ToolDef } from './types.js';
import { textResult } from './types.js';

export interface SqlConfig {
  /** Postgres connection string. Use a READ-ONLY DB user where possible. */
  url: string;
  /** Default schema for describe/list. */
  schema?: string;
  /** Max rows returned per query (hard cap). */
  maxRows?: number;
}

const str = { type: 'string' } as const;

/** Read-only Postgres connector: expose a database (e.g. a Django app's DB) as
 *  MCP query tools WITHOUT touching the app. Every query runs in a READ ONLY
 *  transaction with a statement timeout, so writes are rejected by the engine. */
export class SqlConnector implements Connector {
  private readonly maxRows: number;
  constructor(private readonly cfg: SqlConfig) {
    this.maxRows = cfg.maxRows ?? 1000;
  }

  private client(): pg.Client {
    // Strip sslmode from the URL and drive TLS via the ssl object (recent pg
    // treats sslmode=require as verify-full and rejects managed self-signed CAs).
    const wantSsl = /[?&]sslmode=(require|verify-ca|verify-full)/.test(this.cfg.url);
    const connectionString = this.cfg.url.replace(/([?&])sslmode=[^&]*/, '$1').replace(/[?&]+$/, '');
    return new pg.Client({ connectionString, ssl: wantSsl ? { rejectUnauthorized: false } : undefined });
  }

  async listTools(): Promise<ToolDef[]> {
    // Every SQL tool is read-only by construction (READ ONLY transaction).
    const ro = { readOnly: true, dangerous: false, permissions: ['db.read'] };
    const rowsOut = {
      type: 'object',
      properties: {
        rowCount: { type: 'number' },
        truncated: { type: 'boolean' },
        rows: { type: 'array', items: { type: 'object' } },
      },
    };
    return [
      {
        name: 'list_tables',
        description: 'List database tables (schema.table).',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: rowsOut,
        ...ro,
        recommendedUse: { safe_for_automation: true, requires_user_confirmation: false },
        examples: [{ description: 'List all tables', input: {} }],
      },
      {
        name: 'describe_table',
        description: 'Columns and types of a table.',
        inputSchema: {
          type: 'object',
          properties: { table: str, schema: { ...str, description: 'Default public.' } },
          required: ['table'],
        },
        outputSchema: rowsOut,
        ...ro,
        recommendedUse: { safe_for_automation: true, requires_user_confirmation: false },
        examples: [{ description: 'Describe the users table', input: { table: 'users', schema: 'public' } }],
      },
      {
        name: 'run_query',
        description: 'Run a read-only SQL query (SELECT/WITH only). Use $1,$2… placeholders with params.',
        inputSchema: {
          type: 'object',
          properties: {
            sql: { ...str, description: 'A SELECT/WITH statement.' },
            params: { type: 'array', description: 'Positional params for $1,$2…', items: {} },
          },
          required: ['sql'],
        },
        outputSchema: rowsOut,
        ...ro,
        recommendedUse: { safe_for_automation: true, requires_user_confirmation: false },
        examples: [
          {
            description: 'Daily signups for the last 7 days',
            input: {
              sql: "select date(created_at) d, count(*) n from users where created_at > now() - interval '7 days' group by 1 order by 1",
            },
          },
          {
            description: 'Lookup by id with a param',
            input: { sql: 'select * from users where id = $1', params: ['42'] },
          },
        ],
      },
    ];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallResult> {
    try {
      switch (name) {
        case 'list_tables':
          return await this.query(
            `select table_schema, table_name from information_schema.tables
             where table_type='BASE TABLE' and table_schema not in ('pg_catalog','information_schema')
             order by 1,2`,
          );
        case 'describe_table':
          return await this.query(
            `select column_name, data_type, is_nullable, column_default
             from information_schema.columns where table_name=$1 and table_schema=$2
             order by ordinal_position`,
            [String(args.table), String(args.schema ?? this.cfg.schema ?? 'public')],
          );
        case 'run_query': {
          const sql = String(args.sql ?? '');
          if (!/^\s*(select|with)\b/i.test(sql)) {
            return textResult('Only read-only SELECT/WITH queries are allowed.', true);
          }
          const params = Array.isArray(args.params) ? (args.params as unknown[]) : undefined;
          return await this.query(sql, params);
        }
        default:
          return textResult(`Unknown tool: ${name}`, true);
      }
    } catch (err) {
      return textResult(err instanceof Error ? err.message : String(err), true);
    }
  }

  private async query(sql: string, params?: unknown[]): Promise<CallResult> {
    const c = this.client();
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET TRANSACTION READ ONLY');
      await c.query("SET LOCAL statement_timeout = '15s'");
      const res = await c.query(sql, params);
      await c.query('ROLLBACK');
      const rows = res.rows.slice(0, this.maxRows);
      const truncated = res.rows.length > this.maxRows;
      return textResult(JSON.stringify({ rowCount: res.rows.length, truncated, rows }));
    } finally {
      await c.end().catch(() => {});
    }
  }

  async health(): Promise<HealthResult> {
    const c = this.client();
    try {
      await c.connect();
      await c.query('SELECT 1');
      return { ok: true, message: 'DB connected' };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    } finally {
      await c.end().catch(() => {});
    }
  }

  /** Database schemas (user-visible), as queryable objects. */
  async listObjects(): Promise<SourceObject[]> {
    const c = this.client();
    try {
      await c.connect();
      const res = await c.query(
        `select schema_name from information_schema.schemata
         where schema_name not in ('pg_catalog','information_schema','pg_toast')
           and schema_name not like 'pg_temp%' and schema_name not like 'pg_toast_temp%'
         order by 1`,
      );
      return res.rows.map((r: { schema_name: string }) => ({ id: r.schema_name, name: r.schema_name, type: 'schema' }));
    } catch {
      return [];
    } finally {
      await c.end().catch(() => {});
    }
  }
}
