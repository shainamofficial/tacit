// Slack connector: channel-scoped history backfill with membership-as-ACL
// and per-channel ts cursors (F-ING-2, F-ING-3, F-ING-4, F-ING-6).
// One sync item per top-level message; a thread is one item containing its
// replies, so a "what was decided" answer never loses its context.
import { SyncCursors, SyncStore, emptyStats, inScope, tally, type Acl, type SyncStats } from '@tacit/connector-core';
import type { SlackApi, SlackConversation, SlackMessage, SlackUser } from './api';

export interface SlackSyncOptions {
  readonly sourceId: string;
  readonly domain: string;
  /** Channel names or ids to include; default: every non-archived conversation the bot can read (F-ING-4). */
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  /** Sync DMs and group DMs the bot is party to (default true; they are ACL'd to their members). */
  readonly includeDms?: boolean;
  /** Ignore stored cursors and re-walk full history (dedup makes this cheap). */
  readonly full?: boolean;
  readonly log?: (line: Record<string, unknown>) => void;
}

export const CHANNEL_PREFIX = 'channel:';
export const MSG_PREFIX = 'msg:';
export const cursorKey = (conversationId: string): string => `slack:${conversationId}:latest`;

const SKIP_SUBTYPES = new Set(['channel_join', 'channel_leave', 'group_join', 'group_leave', 'channel_purpose', 'channel_topic', 'channel_name', 'pinned_item', 'unpinned_item']);

export function conversationInScope(c: SlackConversation, opts: SlackSyncOptions): boolean {
  if (c.isArchived) return false;
  if ((c.isIm || c.isMpim) && opts.includeDms === false) return false;
  return inScope([c.name, c.id, `#${c.name}`], opts.include, opts.exclude);
}

export interface UserIndex {
  label(id: string | null): string;
  principal(id: string): string;
}

export function indexUsers(users: readonly SlackUser[]): UserIndex {
  const byId = new Map(users.map((u) => [u.id, u] as const));
  return {
    label: (id) => (id ? (byId.get(id)?.realName || byId.get(id)?.name || id) : 'system'),
    principal: (id) => byId.get(id)?.email?.toLowerCase() ?? `slack:${id}`,
  };
}

function stamp(ts: string): string {
  const d = new Date(Number(ts.split('.')[0]) * 1000);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

export function renderThread(conversation: SlackConversation, messages: readonly SlackMessage[], users: UserIndex): string {
  const label = conversation.isIm || conversation.isMpim ? 'DM' : `#${conversation.name}`;
  const lines = messages.map((m, i) => `${i === 0 ? '' : '  ↳ '}[${stamp(m.ts)}] ${users.label(m.user)}: ${m.text}`);
  return `${label}\n${lines.join('\n')}\n`;
}

function isRoot(m: SlackMessage): boolean {
  return (!m.threadTs || m.threadTs === m.ts) && !(m.subtype && SKIP_SUBTYPES.has(m.subtype));
}

async function conversationAcl(api: SlackApi, c: SlackConversation, users: UserIndex, opts: SlackSyncOptions): Promise<Acl> {
  if (!c.isPrivate && !c.isIm && !c.isMpim) return { kind: 'domain', domain: opts.domain };
  const members = await api.listMembers(c.id);
  return { kind: 'users', emails: members.map((m) => users.principal(m)) };
}

async function syncConversation(api: SlackApi, store: SyncStore, cursors: SyncCursors, opts: SlackSyncOptions, c: SlackConversation, users: UserIndex, stats: SyncStats): Promise<void> {
  const acl = await conversationAcl(api, c, users, opts);
  tally(
    stats,
    await store.upsert({
      sourceId: opts.sourceId,
      externalId: `${CHANNEL_PREFIX}${c.id}`,
      kind: 'channel',
      title: c.isIm || c.isMpim ? `DM ${c.id}` : `#${c.name}`,
      content: `${c.isIm || c.isMpim ? `DM ${c.id}` : `#${c.name}`}\nTopic: ${c.topic || '(none)'}\nPurpose: ${c.purpose || '(none)'}\nPrivate: ${c.isPrivate || c.isIm || c.isMpim ? 'yes' : 'no'}\n`,
      acl,
      meta: { name: c.name, private: c.isPrivate, im: c.isIm, mpim: c.isMpim, topic: c.topic, purpose: c.purpose },
    }),
  );

  const oldest = opts.full ? null : await cursors.get(opts.sourceId, cursorKey(c.id));
  const messages = await api.history(c.id, oldest ? { oldest } : {});
  let newest = oldest ?? '0';
  for (const m of messages) {
    if (Number(m.ts) > Number(newest)) newest = m.ts;
    if (!isRoot(m)) continue;
    const thread = m.replyCount && m.replyCount > 0 ? await api.replies(c.id, m.ts) : [m];
    const root = thread[0] ?? m;
    tally(
      stats,
      await store.upsert({
        sourceId: opts.sourceId,
        externalId: `${MSG_PREFIX}${c.id}:${m.ts}`,
        kind: 'message',
        title: `${c.isIm || c.isMpim ? 'DM' : `#${c.name}`} · ${stamp(m.ts).slice(0, 10)} · ${users.label(root.user)}`,
        content: renderThread(c, thread, users),
        acl,
        meta: { conversation: c.id, ts: m.ts, user: root.user, principal: root.user ? users.principal(root.user) : null, reply_count: thread.length - 1, is_thread: thread.length > 1 },
        updatedAt: new Date(Number((thread[thread.length - 1] ?? m).ts.split('.')[0]) * 1000),
      }),
    );
  }
  if (Number(newest) > Number(oldest ?? '0')) await cursors.set(opts.sourceId, cursorKey(c.id), newest);
}

/**
 * Backfill (no cursors yet) or incremental sync (cursors present) of every
 * in-scope conversation. New replies to threads older than the cursor are not
 * picked up here; that is the Events API's job (P1).
 */
export async function syncSlack(api: SlackApi, store: SyncStore, cursors: SyncCursors, opts: SlackSyncOptions): Promise<SyncStats> {
  const stats = emptyStats();
  const users = indexUsers(await api.listUsers());
  const conversations = (await api.listConversations()).filter((c) => conversationInScope(c, opts));
  for (const c of conversations) await syncConversation(api, store, cursors, opts, c, users, stats);
  opts.log?.({ event: 'sync', source: 'slack', conversations: conversations.length, full: opts.full ?? false, ...stats });
  return stats;
}
