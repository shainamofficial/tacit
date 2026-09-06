// Zendesk-style tickets (200) and macros (12), authored by Support.
// Story tickets carry T09 (photo-before-RMA norm), the Vantage Systems
// customer context (P02 decoy), and macro applications (C01/C09/C24/D14).
import { Q } from './plants';
import type { Rng } from './rng';
import { CUSTOMERS, SUPPORT, daysAgo, person, type PersonKey } from './world';

export interface Macro {
  readonly id: number;
  readonly title: string;
  readonly body: string;
  readonly author: PersonKey;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface TicketComment {
  readonly id: number;
  readonly author: string;
  readonly body: string;
  readonly createdAt: Date;
  readonly public: boolean;
}

export interface Ticket {
  readonly id: number;
  readonly subject: string;
  readonly description: string;
  readonly status: 'open' | 'pending' | 'solved' | 'closed';
  readonly priority: 'low' | 'normal' | 'high' | 'urgent';
  readonly requester: { name: string; email: string; organization: string };
  readonly assignee: PersonKey;
  readonly tags: readonly string[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly comments: readonly TicketComment[];
}

const MACRO_DEFS: ReadonlyArray<[string, string]> = [
  ['Password reset', 'Please use the "Forgot password" link on the sign-in page. If SSO is enabled for your organization, reset it through your identity provider instead.'],
  ['Robot offline: first steps', 'Please power-cycle the robot and confirm the fleet agent shows it as online. If it stays offline for more than 10 minutes, reply with the robot serial and we will pull the logs.'],
  ['Request logs', 'Could you export the diagnostic bundle from the fleet page (Robot → Diagnostics → Export) and attach it here?'],
  ['Refund request', `${Q.C01_B} If your purchase falls inside that window, reply with the invoice number and we will process it within 3 business days.`],
  ['P2 acknowledgement', `Thanks for the report. ${Q.X01_B} We will keep this ticket updated.`],
  ['Firmware update steps', 'Firmware updates roll out per site from the control plane. Go to Site → Firmware, choose the channel, and schedule the window.'],
  ['Support hours', `${Q.C09_A} Tickets opened outside those hours are picked up first thing the next business day.`],
  ['Invoice due dates', `${Q.X08_B} Enterprise customers with custom terms should refer to their order form.`],
  ['Hardware return (RMA)', `${Q.C24_B} ${Q.X09_B}`],
  ['Escalate to engineering', 'We have escalated this to the engineering owner and will update you within one business day.'],
  ['Pause subscription', `${Q.D14_DOC}`],
  ['Close: resolved', 'Glad that fixed it. We are closing this ticket; reply any time to reopen it.'],
];

const SUBJECTS: ReadonlyArray<[string, string, string[]]> = [
  ['Robot {serial} offline since this morning', 'The unit shows a red LED and the fleet page lists it as offline. Nothing changed on our side.', ['offline', 'hardware']],
  ['Invoice {inv} shows the wrong amount', 'The invoice total does not match the number of active robots last month.', ['billing']],
  ['Firmware update failed on {serial}', 'The update sits at 60% and then the robot reboots. Second attempt did the same.', ['firmware']],
  ['Add a user to the control plane', 'Please add our new shift lead as an operator on the control plane.', ['account']],
  ['Arm calibration drifting on aisle {n}', 'Picks are landing a few millimeters off in one aisle only.', ['calibration']],
  ['API returning 429 unexpectedly', 'Our integration is getting rate limited at what looks like a low request rate.', ['api']],
  ['Webhook deliveries failing', 'We stopped receiving pick.completed events yesterday around noon.', ['api', 'webhooks']],
  ['Question about refund on annual plan', 'We would like to understand the refund terms before renewing.', ['billing', 'refund']],
  ['Pause our subscription over the summer', 'Our site closes for six weeks; can billing pause during that time?', ['billing']],
  ['Password reset not working', 'The reset email never arrives.', ['account']],
  ['Export telemetry for last quarter', 'Finance needs pick counts per robot for the quarter.', ['telemetry']],
  ['Gripper pads wearing out quickly', 'Pads last two weeks instead of the expected two months.', ['hardware', 'consumables']],
  ['Maintenance window this weekend?', 'Will there be downtime on Saturday night? We run a night shift.', ['maintenance']],
  ['Robot {serial} reports low battery constantly', 'Battery reads 15% right after a full charge.', ['hardware', 'battery']],
  ['Cannot register a new site', 'The site token is rejected with an unauthorized error.', ['account', 'api']],
];

export function buildZendesk(parent: Rng): { macros: Macro[]; tickets: Ticket[] } {
  const rng = parent.fork('zendesk');

  const macros: Macro[] = MACRO_DEFS.map(([title, body], i) => {
    const created = daysAgo(rng.int(420, 520), rng.int(9, 17));
    return {
      id: i + 1,
      title,
      body,
      author: 'priya',
      createdAt: created,
      updatedAt: daysAgo(rng.int(60, 400), rng.int(9, 17)),
    };
  });
  const macroBody = (id: number): string => {
    const m = macros[id - 1];
    if (!m) throw new Error(`no macro ${id}`);
    return m.body;
  };

  const tickets: Ticket[] = [];
  let commentId = 50_000;
  const agentSig = (k: PersonKey): string => `\n\n${person(k).first}\nNorthwind Support`;

  function makeTicket(
    id: number,
    subject: string,
    description: string,
    tags: string[],
    org: string,
    days: number,
    replies: Array<[PersonKey | 'requester', string]>,
    status: Ticket['status'] = 'solved',
  ): Ticket {
    const created = daysAgo(days, rng.int(7, 19), rng.int(0, 59));
    const assignee = rng.pick(SUPPORT);
    const requesterName = `${rng.pick(['Jordan', 'Casey', 'Morgan', 'Taylor', 'Riley', 'Avery', 'Quinn', 'Reese', 'Sasha', 'Emerson'])} ${rng.pick(['Adler', 'Brooks', 'Castillo', 'Dubois', 'Eriksen', 'Fontaine', 'Gallo', 'Hughes', 'Ivers', 'Jansen'])}`;
    const requesterEmail = `${requesterName.toLowerCase().replace(' ', '.')}@${org.toLowerCase().replace(/[^a-z]+/g, '')}.example`;
    let t = created.getTime();
    const comments: TicketComment[] = [
      { id: commentId++, author: requesterEmail, body: description, createdAt: new Date(t), public: true },
    ];
    for (const [who, body] of replies) {
      t += rng.int(30, 600) * 60_000;
      const author = who === 'requester' ? requesterEmail : person(who).email;
      comments.push({ id: commentId++, author, body: who === 'requester' ? body : body + agentSig(who), createdAt: new Date(t), public: true });
    }
    return {
      id,
      subject,
      description,
      status,
      priority: rng.pick(['low', 'normal', 'normal', 'normal', 'high', 'urgent']),
      requester: { name: requesterName, email: requesterEmail, organization: org },
      assignee,
      tags,
      createdAt: created,
      updatedAt: new Date(t),
      comments,
    };
  }

  // --- story tickets
  let id = 1001;
  const rmaOrgs = ['Bluefin Grocers', 'Orion Parcel', 'Atlas Cold Chain', 'Northgate Wholesale', 'Marigold Beauty', 'Ironbridge Tools'];
  for (const org of rmaOrgs) {
    const serial = `NW-${rng.int(1000, 9999)}`;
    const agent = rng.pick(SUPPORT);
    tickets.push(
      makeTicket(
        id++,
        `RMA request for ${serial}: gripper damaged`,
        `The gripper on ${serial} is cracked after a collision with a tote rack. We need a replacement.`,
        ['rma', 'hardware'],
        org,
        rng.int(30, 500),
        [
          [agent, Q.T09_ASK],
          ['requester', 'Photo attached.'],
          [agent, `Thanks, approved. ${macroBody(9)}`],
        ],
      ),
    );
  }
  for (const [subject, description] of [
    ['Vantage Systems: second site onboarding', 'We are bringing our Denver site online next month and need 20 more robot registrations.'],
    ['Vantage Systems: invoice split by site', 'Can invoices be split between our two sites for cost allocation?'],
    ['Vantage Systems: API key for warehouse management integration', 'Our WMS team needs credentials for the control plane API.'],
  ] as const) {
    tickets.push(
      makeTicket(id++, subject, description, ['enterprise', 'account'], 'Vantage Systems', rng.int(60, 290), [
        [rng.pick(SUPPORT), 'On it. I have looped in your account executive, Hannah, for the commercial side.'],
        ['requester', 'Great, thank you.'],
      ]),
    );
  }
  for (let i = 0; i < 4; i++) {
    tickets.push(
      makeTicket(id++, 'Question about refund on annual plan', 'We would like to understand the refund terms before renewing.', ['billing', 'refund'], rng.pick(CUSTOMERS).name, rng.int(20, 500), [
        [rng.pick(SUPPORT), macroBody(4)],
      ]),
    );
  }
  for (let i = 0; i < 3; i++) {
    tickets.push(
      makeTicket(id++, 'Pause our subscription over the summer', 'Our site closes for six weeks; can billing pause during that time?', ['billing'], rng.pick(CUSTOMERS).name, rng.int(20, 500), [
        [rng.pick(SUPPORT), macroBody(11)],
        ['requester', 'Perfect, thanks.'],
      ]),
    );
  }
  tickets.push(
    makeTicket(id++, 'Foxtrot Logistics: PO number missing on invoices', 'Our AP team rejects invoices without our PO number. Please add PO 88213 to all invoices.', ['billing', 'enterprise'], 'Foxtrot Logistics', 240, [
      ['aisha', 'Added the PO reference to your billing profile; it will appear from the next invoice.'],
    ]),
  );
  tickets.push(
    makeTicket(id++, 'Foxtrot Logistics: robot count for Q2 true-up', 'Please confirm the active robot count used for the Q2 true-up.', ['billing', 'enterprise'], 'Foxtrot Logistics', 110, [
      ['leo', 'Confirmed 120 active robots across both sites for Q2.'],
    ]),
  );

  // --- templated fill to 200
  while (tickets.length < 200) {
    const [subjectT, descriptionT, tags] = rng.pick(SUBJECTS);
    const serial = `NW-${rng.int(1000, 9999)}`;
    const subject = subjectT.replace('{serial}', serial).replace('{inv}', `INV-${rng.int(20000, 29999)}`).replace('{n}', String(rng.int(1, 24)));
    const org = rng.pick(CUSTOMERS.filter((c) => c.name !== 'Vantage Systems' && c.name !== 'Foxtrot Logistics')).name;
    const agent = rng.pick(SUPPORT);
    const replies: Array<[PersonKey | 'requester', string]> = [];
    if (tags.includes('offline') || tags.includes('hardware')) replies.push([agent, macroBody(2)]);
    else if (tags.includes('account')) replies.push([agent, macroBody(1)]);
    else if (tags.includes('firmware')) replies.push([agent, macroBody(6)]);
    else if (tags.includes('maintenance')) replies.push([agent, 'Yes, there is a maintenance window this weekend; see the status page for the exact time.']);
    else if (tags.includes('api')) replies.push([agent, macroBody(10)]);
    else if (tags.includes('billing') && subjectT.includes('refund')) replies.push([agent, macroBody(4)]);
    else replies.push([agent, macroBody(3)]);
    if (rng.chance(0.6)) replies.push(['requester', rng.pick(['That fixed it, thanks.', 'Done, attached.', 'Still seeing it, any update?', 'Thanks for the quick reply.'])]);
    if (rng.chance(0.5)) replies.push([agent, macroBody(12)]);
    tickets.push(makeTicket(id++, subject, descriptionT, [...tags], org, rng.int(1, 545), replies, rng.pick(['solved', 'solved', 'closed', 'open', 'pending'])));
  }

  return { macros, tickets };
}

export function serializeMacros(macros: readonly Macro[]): unknown {
  return macros.map((m) => ({
    id: m.id,
    title: m.title,
    active: true,
    author: person(m.author).email,
    created_at: m.createdAt.toISOString(),
    updated_at: m.updatedAt.toISOString(),
    actions: [{ field: 'comment_value', value: m.body }],
    restriction: null,
  }));
}

export function serializeTickets(tickets: readonly Ticket[]): unknown {
  return tickets.map((t) => ({
    id: t.id,
    subject: t.subject,
    description: t.description,
    status: t.status,
    priority: t.priority,
    requester: t.requester,
    assignee_email: person(t.assignee).email,
    tags: t.tags,
    created_at: t.createdAt.toISOString(),
    updated_at: t.updatedAt.toISOString(),
    comments: t.comments.map((c) => ({
      id: c.id,
      author_email: c.author,
      body: c.body,
      created_at: c.createdAt.toISOString(),
      public: c.public,
    })),
  }));
}
