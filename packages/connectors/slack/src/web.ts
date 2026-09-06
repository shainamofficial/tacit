// @slack/web-api-backed SlackApi. Bot token scopes (read-only):
// channels:read, groups:read, im:read, mpim:read, channels:history,
// groups:history, im:history, mpim:history, users:read, users:read.email.
import { WebClient } from '@slack/web-api';
import type { SlackApi, SlackConversation, SlackMessage, SlackUser } from './api';

export const SLACK_BOT_SCOPES = [
  'channels:read',
  'groups:read',
  'im:read',
  'mpim:read',
  'channels:history',
  'groups:history',
  'im:history',
  'mpim:history',
  'users:read',
  'users:read.email',
] as const;

interface RawMessage {
  ts?: string;
  user?: string;
  text?: string;
  subtype?: string;
  thread_ts?: string;
  reply_count?: number;
}

interface Paged {
  response_metadata?: { next_cursor?: string };
}

function toMessage(m: RawMessage): SlackMessage | null {
  if (!m.ts) return null;
  return {
    ts: m.ts,
    user: m.user ?? null,
    text: m.text ?? '',
    ...(m.subtype ? { subtype: m.subtype } : {}),
    ...(m.thread_ts ? { threadTs: m.thread_ts } : {}),
    ...(m.reply_count !== undefined ? { replyCount: m.reply_count } : {}),
  };
}

/** Walk Slack's cursor pagination over a typed method call. */
async function* pages<T extends Paged>(call: (cursor: string | undefined) => Promise<T>): AsyncGenerator<T> {
  let cursor: string | undefined;
  do {
    const page = await call(cursor);
    yield page;
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
}

export class SlackWebApi implements SlackApi {
  constructor(private readonly client: WebClient) {}

  static fromToken(token: string): SlackWebApi {
    return new SlackWebApi(new WebClient(token));
  }

  async listConversations(): Promise<SlackConversation[]> {
    const out: SlackConversation[] = [];
    for await (const page of pages((cursor) => this.client.conversations.list({ types: 'public_channel,private_channel,mpim,im', exclude_archived: false, limit: 1000, ...(cursor ? { cursor } : {}) }))) {
      for (const c of page.channels ?? []) {
        if (!c.id) continue;
        out.push({
          id: c.id,
          name: c.name ?? c.id,
          isPrivate: c.is_private ?? false,
          isArchived: c.is_archived ?? false,
          isIm: c.is_im ?? false,
          isMpim: c.is_mpim ?? false,
          topic: c.topic?.value ?? '',
          purpose: c.purpose?.value ?? '',
        });
      }
    }
    return out;
  }

  async listMembers(conversationId: string): Promise<string[]> {
    const out: string[] = [];
    for await (const page of pages((cursor) => this.client.conversations.members({ channel: conversationId, limit: 1000, ...(cursor ? { cursor } : {}) }))) {
      out.push(...(page.members ?? []));
    }
    return out;
  }

  async listUsers(): Promise<SlackUser[]> {
    const out: SlackUser[] = [];
    for await (const page of pages((cursor) => this.client.users.list({ limit: 1000, ...(cursor ? { cursor } : {}) }))) {
      for (const u of page.members ?? []) {
        if (!u.id) continue;
        out.push({
          id: u.id,
          name: u.name ?? u.id,
          realName: u.real_name ?? u.profile?.real_name ?? u.name ?? u.id,
          email: u.profile?.email ?? null,
          isBot: u.is_bot ?? false,
          deleted: u.deleted ?? false,
        });
      }
    }
    return out;
  }

  async history(conversationId: string, opts: { oldest?: string }): Promise<SlackMessage[]> {
    const out: SlackMessage[] = [];
    for await (const page of pages((cursor) =>
      this.client.conversations.history({ channel: conversationId, limit: 999, ...(opts.oldest ? { oldest: opts.oldest, inclusive: false } : {}), ...(cursor ? { cursor } : {}) }),
    )) {
      for (const m of (page.messages ?? []) as RawMessage[]) {
        const msg = toMessage(m);
        if (msg) out.push(msg);
      }
    }
    return out.sort((a, b) => Number(a.ts) - Number(b.ts));
  }

  async replies(conversationId: string, threadTs: string): Promise<SlackMessage[]> {
    const out: SlackMessage[] = [];
    for await (const page of pages((cursor) => this.client.conversations.replies({ channel: conversationId, ts: threadTs, limit: 999, ...(cursor ? { cursor } : {}) }))) {
      for (const m of (page.messages ?? []) as RawMessage[]) {
        const msg = toMessage(m);
        if (msg) out.push(msg);
      }
    }
    return out.sort((a, b) => Number(a.ts) - Number(b.ts));
  }
}
