// Slack export (SPEC §2): ~2,000 messages across 8 channels plus one DM,
// in the real export layout (users.json, channels.json, dms.json,
// <conversation>/<YYYY-MM-DD>.json). Channel membership is the ACL.
import { Q } from './plants';
import type { Rng } from './rng';
import {
  CHANNELS,
  CUSTOMERS,
  DM_JENNA_ALICE,
  ENGINEERS,
  EVERYONE,
  PEOPLE,
  SALES,
  SUPPORT,
  channel,
  commitDaysAgo,
  daysAgo,
  isoDay,
  person,
  type PersonKey,
} from './world';

export interface SlackMessage {
  /** channel name (e.g. "sales") or DM id (e.g. "D0000001") */
  readonly conversation: string;
  readonly user: PersonKey;
  readonly text: string;
  readonly at: Date;
  readonly ts: string;
  readonly threadTs?: string;
  readonly pinned?: boolean;
  readonly reactions?: ReadonlyArray<{ name: string; users: PersonKey[] }>;
  /** export file this message is written to */
  readonly file: string;
}

export interface SlackExport {
  readonly messages: SlackMessage[];
  readonly files: ReadonlyArray<{ path: string; json: unknown }>;
}

interface Draft {
  conversation: string;
  user: PersonKey;
  text: string;
  at: Date;
  /** replies reference the parent's draft key */
  key?: string;
  replyTo?: string;
  pinned?: boolean;
  reactions?: Array<{ name: string; users: PersonKey[] }>;
}

export const NOISE = [
  'lunch at 12:30? thinking the taco place',
  'anyone else getting VPN drops this morning?',
  'coffee machine on 3 is broken again :coffee: :sob:',
  'standup in 5',
  'PR review please, small one',
  'TIL you can filter the fleet page by firmware channel',
  ':tada: congrats team',
  'happy friday everyone',
  'brb, school pickup',
  'the new office plants are thriving, unlike my code',
  'who left a robot gripper in the kitchen',
  'reminder: submit expenses by the 5th',
  'wfh today, ping me on here',
  'anyone have the wifi password for the demo floor?',
  'that meme in #random is why I come to work',
  ':wave: welcome to the new folks joining this week',
  'heads down until 3, will catch up after',
  'is it just me or is the build slow today',
  'great customer call just now, notes coming',
  'ok who ordered 400 suction cups',
  'I updated the wiki page, let me know if anything is off',
  'note to self: never trust a green build on a Friday',
];

const ROUTINE: Record<string, (rng: Rng) => [PersonKey, string]> = {
  general: (rng) => [
    rng.pick(['noah', 'alice', 'kai', 'elif']),
    rng.pick([
      'All-hands is Thursday at 11:00 ET, agenda in the calendar invite.',
      'Facilities: the 3rd floor will be repainted next week, expect fumes.',
      'New starter today, say hi in #general!',
      'Reminder: benefits enrollment closes end of month.',
      'The office kitchen restock is on Tuesdays now.',
      'Q&A with Alice tomorrow, drop questions in the thread.',
      'Parking garage closed Saturday for maintenance.',
    ]),
  ],
  eng: (rng) => [
    rng.pick(ENGINEERS),
    rng.pick([
      `Deploying control-plane ${2026 - rng.int(0, 1)}.${String(rng.int(1, 12)).padStart(2, '0')}.${String(rng.int(1, 28)).padStart(2, '0')} to prod now.`,
      'Staging is green again after the terraform fix.',
      'Flaky test in fleet-agent telemetry suite, retrying.',
      'Node 22 upgrade PR is up for review.',
      'Dependabot bumps merged, nothing exciting.',
      'Postgres minor upgrade applied to staging.',
      'Heads up: rotating the staging webhook secrets this afternoon.',
      'New dashboard for pick latency p95 is in Grafana.',
      'Anyone seen the SDK release checklist doc?',
    ]),
  ],
  support: (rng) => [
    rng.pick(SUPPORT),
    rng.pick([
      `Ticket #${rng.int(1001, 1200)} escalated: robot offline after firmware update.`,
      `Customer ${rng.pick(CUSTOMERS).name} asking about the maintenance window this weekend.`,
      'Applied the RMA macro on three tickets this morning, all gripper pads.',
      `Ticket #${rng.int(1001, 1200)}: invoice amount question, looping in #billing.`,
      'Queue is at 14 open, all within SLA.',
      'New macro for firmware rollback steps is live.',
      'Weekend coverage: I have Saturday, Ben has Sunday.',
    ]),
  ],
  billing: (rng) => [
    rng.pick(['marcus', 'elif', 'tom', 'sam']),
    rng.pick([
      `Invoice run complete: ${rng.int(180, 240)} invoices, ${rng.int(0, 4)} failures.`,
      'Dunning batch sent for the overdue list.',
      'Stripe webhook backlog cleared.',
      'Credit note issued for the double-charged Growth account.',
      'FX rates refreshed for the month.',
      'Reminder: month-end close starts Thursday.',
      'billing-service deploy went out, no schema changes.',
    ]),
  ],
  product: (rng) => [
    rng.pick(['ivan', 'grace', 'theo']),
    rng.pick([
      `Feedback from ${rng.pick(CUSTOMERS).name}: they want per-aisle pick stats.`,
      'Batch-pick adoption is up again this week.',
      'Fleet page redesign mockups are in Figma, comments welcome.',
      'Roadmap review moved to Wednesday.',
      'Pick accuracy held at 99.6% this week.',
      'Onboarding funnel: drop-off is still at the robot registration step.',
    ]),
  ],
  sales: (rng) => [
    rng.pick(SALES),
    rng.pick([
      `Closed-won: ${rng.pick(CUSTOMERS.filter((c) => c.name !== 'Vantage Systems')).name}, ${rng.int(4, 60)} robots.`,
      'Pipeline review at 2pm, update your stages please.',
      `Demo scheduled with a prospect in ${rng.pick(['Madrid', 'Lyon', 'Austin', 'Toronto', 'Dublin'])}.`,
      'New case study PDF is in the shared drive.',
      'Anyone have the latest pricing sheet link handy?',
      'Renewal season kicking off, list in the CRM.',
    ]),
  ],
  incidents: (rng) => [
    rng.pick([...ENGINEERS, 'priya']),
    rng.pick([
      `inc-${rng.int(1900, 2100)} opened: elevated 5xx on the fleet API.`,
      `inc-${rng.int(1900, 2100)} resolved: root cause was a bad config push.`,
      'On-call handover done, nothing open.',
      'Pager test at 10:00, ignore the noise.',
      'Postmortem doc for last week is in the Runbooks folder.',
      'Robot offline alerts are noisy again, tuning thresholds.',
    ]),
  ],
  exec: (rng) => [
    rng.pick(['alice', 'tom', 'sofia', 'jenna']),
    rng.pick([
      'Board deck draft is in the exec folder.',
      'Hiring plan review Friday.',
      'Pipeline looks healthy for the quarter.',
      'EU expansion update: two more sites live.',
      'Offsite agenda draft attached in the calendar invite.',
    ]),
  ],
};

function storyDrafts(): Draft[] {
  const d = (
    conversation: string,
    user: PersonKey,
    text: string,
    days: number,
    hour: number,
    extra: Partial<Draft> = {},
  ): Draft => ({ conversation, user, text, at: daysAgo(days, hour, 0), ...extra });

  const t05Day = commitDaysAgo(93) + 5;

  return [
    // --- contradictions where Slack is the newer source
    d('billing', 'priya', Q.C01_TRUTH, 12, 14),
    d('general', 'tom', Q.C05_B, 25, 9),
    d('sales', 'sofia', Q.C06_B, 40, 11),
    d('eng', 'jenna', Q.C11_B, 30, 9),
    d('incidents', 'jenna', Q.C12_B, 90, 10, { pinned: true }),
    d('sales', 'sofia', Q.C13_B, 55, 15),
    d('incidents', 'jenna', Q.C14_B, 20, 10, { pinned: true }),
    d('sales', 'hannah', 'Who owns Foxtrot Logistics these days? CRM still says Raj.', 70, 13, { key: 'c17' }),
    d('sales', 'sofia', Q.C17_B, 70, 13, { replyTo: 'c17' }),
    d('general', 'noah', 'Poll: keep Wednesday as the meeting-free day, or move it to Thursday? React :large_blue_square: for Wednesday, :large_green_square: for Thursday.', 18, 10, {
      reactions: [
        { name: 'large_blue_square', users: ['lena', 'omar', 'maya'] },
        { name: 'large_green_square', users: ['jenna', 'marcus', 'priya', 'sofia', 'ivan', 'noah', 'raj', 'theo'] },
      ],
    }),
    d('general', 'noah', Q.C21_B, 15, 10),
    d('general', 'noah', Q.C23_B, 10, 9),
    d('billing', 'marcus', Q.C25_B, 8, 9),

    // --- tribal knowledge (implied, never stated)
    d('billing', 'hannah', Q.T01_HINT1, 200, 11, { key: 't01' }),
    d('billing', 'marcus', Q.T01_HINT1_REPLY, 200, 11, { replyTo: 't01' }),
    d('billing', 'marcus', Q.T01_HINT2, 95, 16),
    d('incidents', 'jenna', Q.T03_HINT1, 210, 9, { key: 't03' }),
    d('incidents', 'dev', Q.T03_HINT2, 210, 9, { replyTo: 't03' }),
    d('incidents', 'jenna', Q.T03_HINT3, 210, 9, { replyTo: 't03' }),
    d('billing', 'marcus', 'Setting up automated dunning for the Q2 overdue list this week.', 130, 10, { key: 't04' }),
    d('billing', 'priya', Q.T04_HINT, 130, 10, { replyTo: 't04' }),
    d('incidents', 'ben', Q.T05_INCIDENT, t05Day, 8, { key: 't05' }),
    d('incidents', 'dev', 'Looking at the pick confidence numbers from that site now.', t05Day, 8, { replyTo: 't05' }),
    d('support', 'maya', Q.T06_HINT, 160, 15),
    d('product', 'theo', Q.T07_QUESTION, 140, 11, { key: 't07' }),
    d('product', 'jenna', Q.T07_DEFLECT, 140, 11, { replyTo: 't07' }),
    d('sales', 'diego', Q.T08_QUESTION, 65, 14, { key: 't08' }),
    d('sales', 'sofia', Q.T08_ANSWER, 65, 14, { replyTo: 't08' }),
    d('sales', 'sofia', Q.T10_HINT, 28, 16),

    // --- permission traps (restricted conversations) and their public decoys
    d('exec', 'alice', Q.P01_SLACK, 44, 9),
    d('exec', 'alice', Q.P02_SLACK, 60, 17, { key: 'p02' }),
    d('exec', 'tom', Q.P02_SLACK_REPLY, 60, 17, { replyTo: 'p02' }),
    d('sales', 'hannah', `${Q.P02_PUBLIC} :tada:`, 300, 15, {
      reactions: [{ name: 'tada', users: ['sofia', 'raj', 'diego', 'alice'] }],
    }),
    d(DM_JENNA_ALICE.id, 'jenna', Q.P04_DM, 148, 18, { key: 'p04' }),
    d(DM_JENNA_ALICE.id, 'alice', Q.P04_DM_REPLY, 148, 18, { replyTo: 'p04' }),

    // --- distractors (consistent with a doc)
    d('eng', 'lena', Q.X02_B, 100, 10),
    d('general', 'noah', Q.X06_B, 105, 9),
  ];
}

function slackTs(at: Date, seq: number): string {
  return `${Math.floor(at.getTime() / 1000)}.${String(seq).padStart(6, '0')}`;
}

export function buildSlack(parent: Rng): SlackExport {
  const rng = parent.fork('slack');
  const drafts: Draft[] = storyDrafts();

  // Routine + noise fill: ~1,950 messages spread over the span, per channel weights.
  const weights: Record<string, number> = {
    general: 260,
    eng: 340,
    support: 300,
    billing: 200,
    product: 200,
    sales: 300,
    incidents: 260,
    exec: 60,
  };
  for (const ch of CHANNELS) {
    const count = weights[ch.name] ?? 0;
    const routine = ROUTINE[ch.name];
    if (!routine) throw new Error(`no routine generator for #${ch.name}`);
    const members: readonly PersonKey[] = ch.members === 'all' ? EVERYONE : ch.members;
    for (let i = 0; i < count; i++) {
      const days = rng.int(1, 545);
      const at = daysAgo(days, rng.int(8, 19), rng.int(0, 59));
      if (rng.chance(0.3)) {
        drafts.push({ conversation: ch.name, user: rng.pick(members), text: rng.pick(NOISE), at });
      } else {
        const [user, text] = routine(rng);
        const draft: Draft = { conversation: ch.name, user, text, at };
        if (rng.chance(0.15)) {
          draft.reactions = [{ name: rng.pick(['+1', 'eyes', 'rocket', 'pray']), users: [rng.pick(members)] }];
        }
        drafts.push(draft);
        if (rng.chance(0.2)) {
          const key = `r${ch.name}${i}`;
          draft.key = key;
          drafts.push({
            conversation: ch.name,
            user: rng.pick(members),
            text: rng.pick(['+1', 'thanks!', 'on it', 'ack', 'nice', 'will do', 'looking', ':+1:']),
            at: new Date(at.getTime() + rng.int(2, 40) * 60_000),
            replyTo: key,
          });
        }
      }
    }
  }

  // Assign ts: sort per conversation by time, replies after their parent.
  const byKey = new Map<string, Draft>();
  for (const dr of drafts) if (dr.key) byKey.set(dr.key, dr);
  for (const dr of drafts) {
    if (dr.replyTo) {
      const parentDraft = byKey.get(dr.replyTo);
      if (!parentDraft) throw new Error(`reply to unknown draft ${dr.replyTo}`);
      if (dr.at.getTime() <= parentDraft.at.getTime()) {
        dr.at = new Date(parentDraft.at.getTime() + 5 * 60_000);
      }
    }
  }
  drafts.sort((a, b) => a.conversation.localeCompare(b.conversation) || a.at.getTime() - b.at.getTime() || a.text.localeCompare(b.text));

  const tsByKey = new Map<string, string>();
  const messages: SlackMessage[] = [];
  let seq = 0;
  for (const dr of drafts) {
    const ts = slackTs(dr.at, seq++);
    if (dr.key) tsByKey.set(dr.key, ts);
    const threadTs = dr.replyTo ? tsByKey.get(dr.replyTo) : undefined;
    if (dr.replyTo && !threadTs) throw new Error(`parent ts missing for ${dr.replyTo}`);
    const msg: SlackMessage = {
      conversation: dr.conversation,
      user: dr.user,
      text: dr.text,
      at: dr.at,
      ts,
      file: `slack/${dr.conversation}/${isoDay(dr.at)}.json`,
      ...(threadTs ? { threadTs } : {}),
      ...(dr.pinned ? { pinned: true } : {}),
      ...(dr.reactions ? { reactions: dr.reactions } : {}),
    };
    messages.push(msg);
  }

  // Serialize in the Slack export shape.
  const replies = new Map<string, SlackMessage[]>();
  for (const m of messages) {
    if (m.threadTs) {
      const list = replies.get(`${m.conversation}:${m.threadTs}`) ?? [];
      list.push(m);
      replies.set(`${m.conversation}:${m.threadTs}`, list);
    }
  }
  const perFile = new Map<string, unknown[]>();
  for (const m of messages) {
    const p = person(m.user);
    const thread = replies.get(`${m.conversation}:${m.ts}`);
    const record: Record<string, unknown> = {
      type: 'message',
      user: p.slackId,
      user_profile: { real_name: p.name, display_name: p.first.toLowerCase() },
      text: m.text,
      ts: m.ts,
      client_msg_id: `nw-${m.conversation}-${m.ts.replace('.', '-')}`,
    };
    if (m.threadTs) {
      record.thread_ts = m.threadTs;
      record.parent_user_id = person(messages.find((x) => x.conversation === m.conversation && x.ts === m.threadTs)?.user ?? m.user).slackId;
    } else if (thread) {
      record.thread_ts = m.ts;
      record.reply_count = thread.length;
      record.reply_users = [...new Set(thread.map((r) => person(r.user).slackId))];
      record.replies = thread.map((r) => ({ user: person(r.user).slackId, ts: r.ts }));
      record.latest_reply = thread[thread.length - 1]?.ts;
    }
    if (m.reactions) {
      record.reactions = m.reactions.map((r) => ({ name: r.name, users: r.users.map((u) => person(u).slackId), count: r.users.length }));
    }
    if (m.pinned) record.pinned_to = [m.conversation.startsWith('D') ? m.conversation : channel(m.conversation).id];
    const list = perFile.get(m.file) ?? [];
    list.push(record);
    perFile.set(m.file, list);
  }

  const files: Array<{ path: string; json: unknown }> = [
    {
      path: 'slack/users.json',
      json: PEOPLE.map((p) => ({
        id: p.slackId,
        name: p.first.toLowerCase(),
        real_name: p.name,
        profile: { email: p.email, title: p.title, real_name: p.name },
        is_admin: p.key === 'alice' || p.key === 'kai',
        deleted: false,
      })),
    },
    {
      path: 'slack/channels.json',
      json: CHANNELS.map((c) => ({
        id: c.id,
        name: c.name,
        created: Math.floor(daysAgo(600).getTime() / 1000),
        creator: person('alice').slackId,
        is_archived: false,
        is_general: c.name === 'general',
        is_private: c.members !== 'all',
        members: (c.members === 'all' ? EVERYONE : c.members).map((k) => person(k).slackId),
        topic: { value: c.topic, creator: person('alice').slackId },
        purpose: { value: c.purpose, creator: person('alice').slackId },
      })),
    },
    {
      path: 'slack/dms.json',
      json: [
        {
          id: DM_JENNA_ALICE.id,
          created: Math.floor(daysAgo(300).getTime() / 1000),
          members: DM_JENNA_ALICE.members.map((k) => person(k).slackId),
        },
      ],
    },
    ...[...perFile.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, json]) => ({ path, json })),
  ];

  return { messages, files };
}
