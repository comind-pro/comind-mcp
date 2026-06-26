import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

const id = () => text('id').primaryKey();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/** User = an account. All control-plane resources are owned by a user and
 *  isolated — no user can see or use another's sources/tools/agents/etc. */
export const users = pgTable(
  'users',
  {
    id: id(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    emailIdx: uniqueIndex('users_email_unique').on(t.email),
  }),
);

const ownerId = () =>
  text('owner_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' });

/**
 * Source = an upstream the gateway aggregates: another MCP server, a REST API
 * (via OpenAPI), or a plain HTTP endpoint. Connectors turn these into tools.
 */
export const sources = pgTable('sources', {
  id: id(),
  ownerId: ownerId(),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['mcp', 'openapi', 'http', 'imap', 'sql'] }).notNull(),
  config: jsonb('config').notNull().$type<Record<string, unknown>>(),
  status: text('status', { enum: ['unknown', 'ok', 'error'] })
    .notNull()
    .default('unknown'),
  statusMessage: text('status_message'),
  createdAt: createdAt(),
});

/**
 * Tool = a single callable. Either native (proxied from a source) or composite
 * (a stored multi-step intent). Curated metadata lives here.
 */
export const tools = pgTable(
  'tools',
  {
    id: id(),
    ownerId: ownerId(),
    sourceId: text('source_id').references(() => sources.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['native', 'composite'] }).notNull(),
    // `name` = curated registry key, unique per owner (e.g. "gmail.send").
    name: text('name').notNull(),
    // `upstreamName` = raw tool/operation name to call on the source connector.
    upstreamName: text('upstream_name'),
    // `displayName` = what agents see; defaults to upstreamName when unset.
    displayName: text('display_name'),
    description: text('description'),
    inputSchema: jsonb('input_schema').$type<Record<string, unknown>>(),
    // optional JSON Schema describing the tool's result (helps models parse output)
    outputSchema: jsonb('output_schema').$type<Record<string, unknown>>(),
    visible: boolean('visible').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => ({
    nameIdx: uniqueIndex('tools_name_unique').on(t.ownerId, t.name),
  }),
);

/** Composite definition (steps) for tools with kind = 'composite'. */
export const composites = pgTable('composites', {
  id: id(),
  toolId: text('tool_id')
    .notNull()
    .references(() => tools.id, { onDelete: 'cascade' }),
  definition: jsonb('definition').notNull().$type<Record<string, unknown>>(),
});

/** Group = a virtual MCP server: a curated bundle of tools exposed at one endpoint. */
export const groups = pgTable(
  'groups',
  {
    id: id(),
    ownerId: ownerId(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    // when true the group exposes built-in schedule_task/list/cancel MCP tools.
    schedulingEnabled: boolean('scheduling_enabled').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => ({
    slugIdx: uniqueIndex('groups_slug_unique').on(t.ownerId, t.slug),
  }),
);

/** M2M: which tools belong to which group. */
export const groupTools = pgTable(
  'group_tools',
  {
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    toolId: text('tool_id')
      .notNull()
      .references(() => tools.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: uniqueIndex('group_tools_pk').on(t.groupId, t.toolId),
  }),
);

/** Agent = a consumer identity (one API key). Access to groups is granted
 *  separately via `agentGroups` (an agent may reach many group endpoints). */
export const agents = pgTable('agents', {
  id: id(),
  ownerId: ownerId(),
  name: text('name').notNull(),
  apiKeyHash: text('api_key_hash').notNull(),
  apiKeyPrefix: text('api_key_prefix').notNull(),
  createdAt: createdAt(),
});

/** M2M grant: which groups an agent's key may call. */
export const agentGroups = pgTable(
  'agent_groups',
  {
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: uniqueIndex('agent_groups_pk').on(t.agentId, t.groupId),
  }),
);

/** Schedule = a cron-driven tool invocation; can be created by the agent (via MCP) or a human (UI). */
export const schedules = pgTable('schedules', {
  id: id(),
  ownerId: ownerId(),
  groupId: text('group_id')
    .notNull()
    .references(() => groups.id, { onDelete: 'cascade' }),
  agentId: text('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  cron: text('cron').notNull(),
  toolName: text('tool_name').notNull(),
  args: jsonb('args').$type<Record<string, unknown>>(),
  enabled: boolean('enabled').notNull().default(true),
  createdBy: text('created_by', { enum: ['agent', 'ui'] }).notNull().default('ui'),
  lastRun: timestamp('last_run', { withTimezone: true }),
  createdAt: createdAt(),
});

/** JobRun = execution log of a schedule. */
export const jobRuns = pgTable('job_runs', {
  id: id(),
  scheduleId: text('schedule_id')
    .notNull()
    .references(() => schedules.id, { onDelete: 'cascade' }),
  status: text('status', { enum: ['running', 'success', 'failed'] }).notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  result: jsonb('result'),
  error: text('error'),
});

/** Secret = encrypted upstream credential (or an env reference); never returned to agents. */
export const secrets = pgTable(
  'secrets',
  {
    id: id(),
    ownerId: ownerId(),
    name: text('name').notNull(),
    // null = global secret; otherwise scoped to a source (overrides global for it).
    sourceId: text('source_id').references(() => sources.id, { onDelete: 'cascade' }),
    encryptedValue: text('encrypted_value'),
    envRef: text('env_ref'),
    createdAt: createdAt(),
  },
  (t) => ({
    nameIdx: uniqueIndex('secrets_name_scope_unique').on(t.ownerId, t.name, t.sourceId),
  }),
);

/** Stored OAuth tokens for sources using the authorization_code (user-delegated) flow. */
export const oauthTokens = pgTable(
  'oauth_tokens',
  {
    id: id(),
    sourceId: text('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    accessEnc: text('access_enc').notNull(),
    refreshEnc: text('refresh_enc'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => ({
    srcIdx: uniqueIndex('oauth_tokens_source_unique').on(t.sourceId),
  }),
);

/** Per-source state for MCP-native OAuth (SDK OAuthClientProvider): DCR client
 *  info, tokens (encrypted), the in-flight PKCE verifier, and the pending
 *  authorize URL captured during the start step. */
export const mcpOauth = pgTable(
  'mcp_oauth',
  {
    id: id(),
    sourceId: text('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    clientInfo: jsonb('client_info').$type<Record<string, unknown>>(),
    tokensEnc: text('tokens_enc'),
    codeVerifier: text('code_verifier'),
    pendingAuthUrl: text('pending_auth_url'),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => ({
    srcIdx: uniqueIndex('mcp_oauth_source_unique').on(t.sourceId),
  }),
);

/* ── Inbound OAuth (we act as Authorization Server for MCP clients like
 *    ChatGPT / Claude.ai connectors). Distinct from `oauthTokens`/`mcpOauth`
 *    above, which are OUTBOUND (us authenticating to upstream sources). ── */

/** Dynamically-registered OAuth client (RFC 7591). Public PKCE clients. */
export const oauthClients = pgTable(
  'oauth_clients',
  {
    id: id(),
    clientId: text('client_id').notNull(),
    clientName: text('client_name'),
    redirectUris: jsonb('redirect_uris').notNull().$type<string[]>(),
    createdAt: createdAt(),
  },
  (t) => ({ cidIdx: uniqueIndex('oauth_clients_client_id_unique').on(t.clientId) }),
);

/** Short-lived authorization codes (PKCE). Bound to the agent the user pasted
 *  on the consent page and the V-MCP group derived from the resource. */
export const oauthAuthCodes = pgTable(
  'oauth_auth_codes',
  {
    id: id(),
    codeHash: text('code_hash').notNull(),
    clientId: text('client_id').notNull(),
    agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    // null = agent-wide (all the agent's groups, via the /a/mcp endpoint)
    groupId: text('group_id').references(() => groups.id, { onDelete: 'cascade' }),
    redirectUri: text('redirect_uri').notNull(),
    codeChallenge: text('code_challenge').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => ({ codeIdx: uniqueIndex('oauth_auth_codes_code_hash_unique').on(t.codeHash) }),
);

/** Issued access/refresh tokens → resolve to an agent + group at the gateway. */
export const oauthAccessTokens = pgTable(
  'oauth_access_tokens',
  {
    id: id(),
    tokenHash: text('token_hash').notNull(),
    refreshHash: text('refresh_hash'),
    clientId: text('client_id').notNull(),
    agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    // null = agent-wide (all the agent's groups, via the /a/mcp endpoint)
    groupId: text('group_id').references(() => groups.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    tokIdx: uniqueIndex('oauth_access_tokens_token_hash_unique').on(t.tokenHash),
  }),
);

/** CallLog = observability record for every tool invocation through the gateway. */
export const callLogs = pgTable(
  'call_logs',
  {
    id: id(),
    ownerId: text('owner_id').notNull(),
    groupId: text('group_id'),
    agentId: text('agent_id'),
    toolName: text('tool_name').notNull(),
    status: text('status', { enum: ['success', 'error'] }).notNull(),
    // how the call was triggered: live = agent via gateway, test = control-plane
    // try-run, schedule = scheduler. Lets analytics exclude dry runs.
    source: text('source', { enum: ['live', 'test', 'schedule'] }).notNull().default('live'),
    durationMs: integer('duration_ms').notNull(),
    tokensEst: integer('tokens_est'),
    error: text('error'),
    ts: createdAt(),
  },
  (t) => ({
    ownerTsIdx: index('call_logs_owner_ts_idx').on(t.ownerId, t.ts),
  }),
);

export const schema = {
  users,
  sources,
  tools,
  composites,
  groups,
  groupTools,
  agents,
  agentGroups,
  schedules,
  jobRuns,
  secrets,
  oauthTokens,
  mcpOauth,
  oauthClients,
  oauthAuthCodes,
  oauthAccessTokens,
  callLogs,
};
