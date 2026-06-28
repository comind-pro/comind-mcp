import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import type { CallResult, Connector, HealthResult, ToolDef } from './types.js';
import { textResult } from './types.js';

export interface MailConfig {
  imap: { host: string; port?: number; secure?: boolean };
  /** Optional — omit for a read-only mailbox (send_message is then unavailable). */
  smtp?: { host: string; port?: number; secure?: boolean };
  /** Mailbox login (full address). */
  user: string;
  /** Password / app password — injected from the vault via `${secret.NAME}`. */
  pass: string;
}

const str = { type: 'string' } as const;
const num = { type: 'number' } as const;

/** Native IMAP/SMTP connector: turns a mailbox into MCP mail tools. Works with
 *  any IMAP/SMTP host (Titan, Gmail, Fastmail, …) — no provider REST API needed. */
export class ImapSmtpConnector implements Connector {
  constructor(private readonly cfg: MailConfig) {}

  private imap(): ImapFlow {
    return new ImapFlow({
      host: this.cfg.imap.host,
      port: this.cfg.imap.port ?? 993,
      secure: this.cfg.imap.secure ?? true,
      auth: { user: this.cfg.user, pass: this.cfg.pass },
      logger: false,
    });
  }

  async listTools(): Promise<ToolDef[]> {
    const list: ToolDef[] = [
      {
        name: 'list_folders',
        description: 'List all mailboxes / folders.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'list_messages',
        description: 'List recent messages in a folder (newest first).',
        inputSchema: {
          type: 'object',
          properties: {
            folder: { ...str, description: 'Mailbox name. Default INBOX.' },
            limit: { ...num, description: 'Max messages. Default 20.' },
            unseen: { type: 'boolean', description: 'Only unread.' },
          },
        },
      },
      {
        name: 'search_messages',
        description: 'Search a folder by sender, subject, text or date.',
        inputSchema: {
          type: 'object',
          properties: {
            folder: str,
            from: str,
            subject: str,
            text: { ...str, description: 'Free-text body/subject match.' },
            since: { ...str, description: 'ISO date — messages on/after.' },
            limit: num,
          },
        },
      },
      {
        name: 'get_message',
        description: 'Fetch one message (headers, body, attachment names) by UID.',
        inputSchema: {
          type: 'object',
          properties: { uid: { ...num, description: 'Message UID.' }, folder: str },
          required: ['uid'],
        },
      },
      ...(this.cfg.smtp
        ? [
            {
              name: 'send_message',
              description: 'Send an email via SMTP.',
              inputSchema: {
                type: 'object',
                properties: {
                  to: { ...str, description: 'Comma-separated recipients.' },
                  subject: str,
                  text: { ...str, description: 'Plain-text body.' },
                  html: { ...str, description: 'HTML body (optional).' },
                  cc: str,
                  bcc: str,
                },
                required: ['to', 'subject'],
              },
            } as ToolDef,
          ]
        : []),
      {
        name: 'mark_seen',
        description: 'Mark a message as read by UID.',
        inputSchema: {
          type: 'object',
          properties: { uid: num, folder: str },
          required: ['uid'],
        },
      },
    ];

    // Curated discovery metadata: reads are safe, send needs confirmation.
    const META: Record<string, Partial<ToolDef>> = {
      list_folders: { readOnly: true, dangerous: false, permissions: ['mail.read'], recommendedUse: { safe_for_automation: true, requires_user_confirmation: false }, examples: [{ description: 'List folders', input: {} }] },
      list_messages: { readOnly: true, dangerous: false, permissions: ['mail.read'], recommendedUse: { safe_for_automation: true, requires_user_confirmation: false }, examples: [{ description: 'Latest 20 unread in INBOX', input: { folder: 'INBOX', limit: 20, unseen: true } }] },
      search_messages: { readOnly: true, dangerous: false, permissions: ['mail.read'], recommendedUse: { safe_for_automation: true, requires_user_confirmation: false }, examples: [{ description: 'From a sender since a date', input: { from: 'boss@acme.com', since: '2026-06-01' } }] },
      get_message: { readOnly: true, dangerous: false, permissions: ['mail.read'], examples: [{ description: 'Fetch one message by UID', input: { uid: 123, folder: 'INBOX' } }] },
      send_message: { readOnly: false, dangerous: true, permissions: ['mail.send'], recommendedUse: { safe_for_automation: false, requires_user_confirmation: true }, examples: [{ description: 'Send a plain email', input: { to: 'a@b.com', subject: 'Hi', text: 'Hello' } }] },
      mark_seen: { readOnly: false, dangerous: false, permissions: ['mail.write'], examples: [{ description: 'Mark a message read', input: { uid: 123 } }] },
    };
    return list.map((t) => ({ ...t, ...META[t.name] }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallResult> {
    try {
      switch (name) {
        case 'list_folders':
          return await this.listFolders();
        case 'list_messages':
          return await this.listMessages(args);
        case 'search_messages':
          return await this.searchMessages(args);
        case 'get_message':
          return await this.getMessage(args);
        case 'send_message':
          return await this.sendMessage(args);
        case 'mark_seen':
          return await this.markSeen(args);
        default:
          return textResult(`Unknown tool: ${name}`, true);
      }
    } catch (err) {
      return textResult(mailError(err), true);
    }
  }

  private async listFolders(): Promise<CallResult> {
    const c = this.imap();
    await c.connect();
    try {
      const list = await c.list();
      return textResult(JSON.stringify(list.map((m) => m.path)));
    } finally {
      await c.logout().catch(() => {});
    }
  }

  private async listMessages(args: Record<string, unknown>): Promise<CallResult> {
    const folder = String(args.folder ?? 'INBOX');
    const limit = Number(args.limit ?? 20);
    const unseen = Boolean(args.unseen);
    const c = this.imap();
    await c.connect();
    const lock = await c.getMailboxLock(folder);
    try {
      const out: unknown[] = [];
      if (unseen) {
        const uids = (await c.search({ seen: false }, { uid: true })) || [];
        const pick = uids.slice(-limit);
        for await (const m of c.fetch(pick.join(','), { uid: true, envelope: true, flags: true }, { uid: true })) {
          out.push(summarise(m));
        }
      } else {
        const total = c.mailbox && typeof c.mailbox !== 'boolean' ? c.mailbox.exists : 0;
        if (total > 0) {
          const start = Math.max(1, total - limit + 1);
          for await (const m of c.fetch(`${start}:*`, { uid: true, envelope: true, flags: true })) {
            out.push(summarise(m));
          }
        }
      }
      out.reverse(); // newest first
      return textResult(JSON.stringify(out));
    } finally {
      lock.release();
      await c.logout().catch(() => {});
    }
  }

  private async searchMessages(args: Record<string, unknown>): Promise<CallResult> {
    const folder = String(args.folder ?? 'INBOX');
    const limit = Number(args.limit ?? 20);
    const query: Record<string, unknown> = {};
    if (args.from) query.from = String(args.from);
    if (args.subject) query.subject = String(args.subject);
    if (args.text) query.body = String(args.text);
    if (args.since) query.since = new Date(String(args.since));
    if (Object.keys(query).length === 0) query.all = true;
    const c = this.imap();
    await c.connect();
    const lock = await c.getMailboxLock(folder);
    try {
      const uids = (await c.search(query, { uid: true })) || [];
      const pick = uids.slice(-limit);
      const out: unknown[] = [];
      if (pick.length) {
        for await (const m of c.fetch(pick.join(','), { uid: true, envelope: true, flags: true }, { uid: true })) {
          out.push(summarise(m));
        }
      }
      out.reverse();
      return textResult(JSON.stringify(out));
    } finally {
      lock.release();
      await c.logout().catch(() => {});
    }
  }

  private async getMessage(args: Record<string, unknown>): Promise<CallResult> {
    const folder = String(args.folder ?? 'INBOX');
    const uid = String(args.uid);
    const c = this.imap();
    await c.connect();
    const lock = await c.getMailboxLock(folder);
    try {
      const msg = await c.fetchOne(uid, { uid: true, source: true }, { uid: true });
      if (!msg || !msg.source) return textResult(`Message uid ${uid} not found`, true);
      const p = await simpleParser(msg.source);
      return textResult(
        JSON.stringify({
          uid: Number(uid),
          from: p.from?.text,
          to: p.to && !Array.isArray(p.to) ? p.to.text : undefined,
          subject: p.subject,
          date: p.date,
          text: p.text,
          html: p.html || undefined,
          attachments: p.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, size: a.size })),
        }),
      );
    } finally {
      lock.release();
      await c.logout().catch(() => {});
    }
  }

  private async sendMessage(args: Record<string, unknown>): Promise<CallResult> {
    if (!this.cfg.smtp) return textResult('SMTP not configured for this source', true);
    const transport = nodemailer.createTransport({
      host: this.cfg.smtp.host,
      port: this.cfg.smtp.port ?? 465,
      secure: this.cfg.smtp.secure ?? true,
      auth: { user: this.cfg.user, pass: this.cfg.pass },
    });
    const info = await transport.sendMail({
      from: this.cfg.user,
      to: String(args.to),
      cc: args.cc ? String(args.cc) : undefined,
      bcc: args.bcc ? String(args.bcc) : undefined,
      subject: String(args.subject ?? ''),
      text: args.text ? String(args.text) : undefined,
      html: args.html ? String(args.html) : undefined,
    });
    return textResult(JSON.stringify({ messageId: info.messageId, accepted: info.accepted }));
  }

  private async markSeen(args: Record<string, unknown>): Promise<CallResult> {
    const folder = String(args.folder ?? 'INBOX');
    const uid = String(args.uid);
    const c = this.imap();
    await c.connect();
    const lock = await c.getMailboxLock(folder);
    try {
      await c.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
      return textResult(JSON.stringify({ uid: Number(uid), seen: true }));
    } finally {
      lock.release();
      await c.logout().catch(() => {});
    }
  }

  async health(): Promise<HealthResult> {
    const c = this.imap();
    try {
      await c.connect();
      await c.noop();
      return { ok: true, message: 'IMAP connected' };
    } catch (err) {
      return { ok: false, message: mailError(err) };
    } finally {
      await c.logout().catch(() => {});
    }
  }
}

interface MsgSummaryInput {
  uid?: number;
  flags?: Set<string>;
  envelope?: {
    subject?: string;
    date?: Date;
    from?: Array<{ name?: string; address?: string }>;
  };
}

/** imapflow / nodemailer throw terse errors ("Command failed"). Surface the
 *  server response, auth flag and error code so the UI shows something useful. */
function mailError(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as {
      message?: string;
      responseText?: string;
      response?: string;
      code?: string;
      authenticationFailed?: boolean;
    };
    const parts: string[] = [];
    if (e.authenticationFailed) parts.push('authentication failed');
    if (e.message) parts.push(e.message);
    if (e.responseText) parts.push(e.responseText);
    else if (e.response) parts.push(String(e.response));
    if (e.code) parts.push(`[${e.code}]`);
    if (parts.length) return parts.join(' — ');
  }
  return err instanceof Error ? err.message : String(err);
}

function summarise(m: MsgSummaryInput): unknown {
  const env = m.envelope ?? {};
  const from = env.from?.[0];
  return {
    uid: m.uid,
    subject: env.subject,
    from: from ? from.name || from.address : undefined,
    date: env.date,
    seen: m.flags ? m.flags.has('\\Seen') : undefined,
  };
}
