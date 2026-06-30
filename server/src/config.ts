import { existsSync, readFileSync } from 'node:fs';

// Lightweight .env loader (no dep): populate process.env from ./.env without
// overriding values already present in the environment.
function loadDotenv(path = '.env'): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined && val !== '') process.env[key] = val;
  }
}
loadDotenv();

function env(key: string, fallback?: string): string {
  const v = process.env[key];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var: ${key}`);
  }
  return v;
}

export const config = {
  port: Number(env('PORT', '8787')),
  host: env('HOST', '127.0.0.1'),
  // Postgres connection string. Local dev defaults to the docker-compose service.
  databaseUrl: env('DATABASE_URL', 'postgres://comind:comind@localhost:5432/comind'),
  // 32-byte key (base64) for the secrets vault (AES-256-GCM). Dev fallback is
  // deterministic & insecure — override VAULT_KEY in any real deployment.
  vaultKey: env('VAULT_KEY', 'ZGV2LW9ubHktaW5zZWN1cmUta2V5LTMyLWJ5dGVzISE='),
  // HMAC secret for signing user session JWTs. Override in production.
  jwtSecret: env('JWT_SECRET', 'dev-only-insecure-jwt-secret-change-me'),
  corsOrigins: env('CORS_ORIGINS', '*'),
  // Public origin used as the OAuth issuer / endpoint base in inbound-OAuth
  // metadata. Must be the externally-reachable URL (e.g. https://mcp.comind.pro),
  // not the bind host. Falls back to the bind host:port for local dev.
  publicBaseUrl:
    (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '') ||
    `http://${env('HOST', '127.0.0.1')}:${env('PORT', '8787')}`,
  // Days to keep call logs; a daily job prunes older rows. 0 = keep forever.
  logRetentionDays: Number(env('LOG_RETENTION_DAYS', '30')),
  // Deployment environment label surfaced via system.whoami (e.g. prod, staging).
  serverEnv: env('SERVER_ENV', process.env.NODE_ENV || 'dev'),
  // Optional build timestamp (ISO string) surfaced via system.version.
  buildTime: process.env.BUILD_TIME || null,
  // How long a cached source status is considered fresh (system.context freshness).
  sourceStatusTtlSeconds: Number(env('SOURCE_STATUS_TTL_SECONDS', '300')),
  // Executable virtual tools: timeout per outbound HTTP call.
  virtualTimeoutMs: Number(env('VIRTUAL_TOOL_TIMEOUT_MS', '15000')),
  // Per-call timeout for upstream connector HTTP fetches (GA / HTTP / OpenAPI).
  upstreamTimeoutMs: Number(env('UPSTREAM_TIMEOUT_MS', '30000')),
  // Max bytes read from an executable virtual tool's response (truncated beyond).
  virtualMaxResponseBytes: Number(env('VIRTUAL_TOOL_MAX_RESPONSE_BYTES', '1048576')),
  // Per-owner outbound rate limit for executable virtual tools (calls/minute).
  virtualRateLimitPerMin: Number(env('VIRTUAL_TOOL_RATE_LIMIT_PER_MIN', '60')),
  // Where the rate-limit counter lives: 'memory' (per-process) or 'pg' (shared
  // across instances). Use 'pg' for any multi-instance deployment.
  virtualRateLimitStore: env('VIRTUAL_RATE_LIMIT_STORE', 'memory'),
  // Optional comma-separated host allowlist for executable virtual tools. When
  // set, only these hosts may be called (and they bypass the private-IP block —
  // explicit opt-in for trusted internal services). Empty = any PUBLIC host.
  virtualHostAllowlist: env('VIRTUAL_TOOL_HOST_ALLOWLIST', '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
};

// Fail-fast: never silently run in a non-dev environment on the insecure dev
// fallback secrets (the defaults are public in the repo — anyone could decrypt a
// vault / forge a JWT for a deployment that forgot to set them).
if (config.serverEnv !== 'dev' && config.serverEnv !== 'test') {
  const missing = ['VAULT_KEY', 'JWT_SECRET'].filter((k) => process.env[k] === undefined);
  if (missing.length) {
    throw new Error(
      `Refusing to start in '${config.serverEnv}' with insecure dev defaults: set ${missing.join(' and ')} ` +
        `(or SERVER_ENV=dev for local development).`,
    );
  }
}

export type Config = typeof config;
