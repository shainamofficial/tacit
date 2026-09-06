// A SlackApi served from the generated Northwind Slack export, with an
// append() hook for incremental-sync tests. Test-only.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { SlackApi, SlackConversation, SlackMessage, SlackUser } from '../api';

interface ExportUser {
  id: string;
  name: string;
  real_name: string;
  profile: { email: string };
  deleted: boolean;
}
interface ExportChannel {
  id: string;
  name: string;
  is_private: boolean;
  is_archived: boolean;
  members: string[];
  topic: { value: string };
  purpose: { value: string };
}
interface ExportDm {
  id: string;
  members: string[];
}
interface ExportMessage {
  user: string;
  text: string;
  ts: string;
  subtype?: string;
  thread_ts?: string;
  reply_count?: number;
}

export interface CorpusSlack extends SlackApi {
  append(conversationId: string, message: SlackMessage): void;
  readonly conversations: readonly SlackConversation[];
}

export function corpusSlackApi(corpusDir: string): CorpusSlack {
  const root = path.join(corpusDir, 'slack');
  const users = JSON.parse(readFileSync(path.join(root, 'users.json'), 'utf8')) as ExportUser[];
  const channels = JSON.parse(readFileSync(path.join(root, 'channels.json'), 'utf8')) as ExportChannel[];
  const dms = JSON.parse(readFileSync(path.join(root, 'dms.json'), 'utf8')) as ExportDm[];

  const conversations: SlackConversation[] = [
    ...channels.map((c) => ({ id: c.id, name: c.name, isPrivate: c.is_private, isArchived: c.is_archived, isIm: false, isMpim: false, topic: c.topic.value, purpose: c.purpose.value })),
    ...dms.map((d) => ({ id: d.id, name: d.id, isPrivate: true, isArchived: false, isIm: true, isMpim: false, topic: '', purpose: '' })),
  ];
  const members = new Map<string, string[]>([...channels.map((c) => [c.id, c.members] as const), ...dms.map((d) => [d.id, d.members] as const)]);
  const dirOf = new Map<string, string>([...channels.map((c) => [c.id, c.name] as const), ...dms.map((d) => [d.id, d.id] as const)]);

  const cache = new Map<string, SlackMessage[]>();
  const load = (conversationId: string): SlackMessage[] => {
    const cached = cache.get(conversationId);
    if (cached) return cached;
    const dir = path.join(root, dirOf.get(conversationId) ?? '');
    const all: SlackMessage[] = [];
    if (existsSync(dir)) {
      for (const file of readdirSync(dir).sort()) {
        for (const m of JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as ExportMessage[]) {
          all.push({
            ts: m.ts,
            user: m.user,
            text: m.text,
            ...(m.subtype ? { subtype: m.subtype } : {}),
            ...(m.thread_ts ? { threadTs: m.thread_ts } : {}),
            ...(m.reply_count !== undefined ? { replyCount: m.reply_count } : {}),
          });
        }
      }
    }
    all.sort((a, b) => Number(a.ts) - Number(b.ts));
    cache.set(conversationId, all);
    return all;
  };

  return {
    conversations,
    async listConversations() {
      return conversations;
    },
    async listMembers(id) {
      return members.get(id) ?? [];
    },
    async listUsers() {
      return users.map((u): SlackUser => ({ id: u.id, name: u.name, realName: u.real_name, email: u.profile.email, isBot: false, deleted: u.deleted }));
    },
    async history(id, opts) {
      const oldest = Number(opts.oldest ?? '0');
      return load(id).filter((m) => (!m.threadTs || m.threadTs === m.ts) && Number(m.ts) > oldest);
    },
    async replies(id, threadTs) {
      return load(id).filter((m) => m.ts === threadTs || m.threadTs === threadTs);
    },
    append(id, message) {
      load(id).push(message);
      load(id).sort((a, b) => Number(a.ts) - Number(b.ts));
    },
  };
}
