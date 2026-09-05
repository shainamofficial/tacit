// Google-Drive-style markdown docs (SPEC §2: 40 docs; 3 Finance-restricted,
// Exec-restricted for P01/P05). Plants are embedded via Q so the manifest can
// locate them verbatim. Doc bodies are short but structurally realistic.
import { Q } from './plants';
import type { Rng } from './rng';
import { CUSTOMERS, daysAgo, person, type PersonKey } from './world';

export type Restriction = 'none' | 'finance' | 'exec';

export interface DriveDoc {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly folder: string;
  /** posix path relative to the generated root, e.g. drive/People/employee-handbook.md */
  readonly path: string;
  readonly restricted: Restriction;
  readonly owner: PersonKey;
  readonly modifiedAt: Date;
  readonly body: string;
}

interface DocDef {
  readonly slug: string;
  readonly title: string;
  readonly folder: string;
  readonly restricted?: Restriction;
  readonly owner: PersonKey;
  /** days before NOW the doc was last modified (recency signals live here) */
  readonly days: number;
  readonly body: string;
}

const h = (title: string, owner: PersonKey, days: number): string =>
  `# ${title}\n\n_Owner: ${person(owner).name} · Last updated: ${daysAgo(days).toISOString().slice(0, 10)}_\n`;

function meetingNotes(rng: Rng, title: string, attendees: PersonKey[], pool: string[]): string {
  const agenda = rng.shuffle(pool).slice(0, rng.int(3, 5));
  const decisions = agenda.slice(0, 2).map((a) => `- ${a}: ${rng.pick(['agreed, no changes', 'deferred to next week', 'owner to write a one-pager', 'ship behind a flag first'])}`);
  const actions = attendees.slice(0, 3).map((a) => `- [ ] ${person(a).first}: ${rng.pick(['follow up with customer', 'update the doc', 'open the PR', 'schedule the review', 'post summary in Slack'])}`);
  return [
    `## ${title}`,
    '',
    `Attendees: ${attendees.map((a) => person(a).name).join(', ')}`,
    '',
    '### Agenda',
    ...agenda.map((a, i) => `${i + 1}. ${a}`),
    '',
    '### Decisions',
    ...decisions,
    '',
    '### Action items',
    ...actions,
    '',
  ].join('\n');
}

export function buildDrive(parent: Rng): DriveDoc[] {
  const rng = parent.fork('drive');

  const productPool = [
    'Batch-pick adoption numbers',
    'Q4 roadmap review',
    'Customer feedback: Bluefin Grocers pilot',
    'Fleet dashboard redesign',
    'Pricing page copy refresh',
    'Onboarding funnel drop-off',
    'Firmware channel naming',
    'Robot health scoring model',
  ];
  const engPool = [
    'control-plane latency regression',
    'Terraform module cleanup',
    'Postgres upgrade plan',
    'On-call handover notes',
    'Webhook retry semantics',
    'SDK release process',
    'Observability gaps in fleet-agent',
    'Dependency bumps',
  ];

  const defs: DocDef[] = [
    // ---------------------------------------------------------------- People
    {
      slug: 'employee-handbook',
      title: 'Employee Handbook',
      folder: 'People',
      owner: 'noah',
      days: 60,
      body: `## Welcome

Northwind Robotics builds warehouse picking-arm robots and the control plane that runs them. This handbook covers the policies that apply to everyone.

## Time off

${Q.C04_A} Unused days roll over up to 5 days into the next calendar year.
${Q.X06_A}
${Q.X12_A}

## Working rhythm

${Q.C21_A} Core collaboration hours are 10:00 to 15:00 in your local time zone.

## Expenses and travel

See the Expense Policy in the Ops folder for limits and tooling.

## Conduct

Be direct, be kind, write things down. Escalate concerns to your manager or to People Ops.
`,
    },
    {
      slug: 'onboarding-guide',
      title: 'New Hire Onboarding Guide',
      folder: 'People',
      owner: 'noah',
      days: 400,
      body: `## Your first week

1. Laptop and accounts arrive from IT (see IT Onboarding in the Security folder).
2. Read the PRD for the control plane and the fleet-agent README.
3. Shadow a support shift on day three.

## Time off

${Q.C04_B}

## Where things run

${Q.D07_DOC} Staging mirrors production in a separate account.

## Useful channels

#general for announcements, #eng for deploys, #support for escalations, #incidents for on-call.
`,
    },
    {
      slug: 'pto-policy',
      title: 'PTO Policy',
      folder: 'People',
      owner: 'noah',
      days: 200,
      body: `## Entitlement

${Q.X07_A} Part-time employees accrue pro rata.

## Requesting time off

Request PTO in the HR tool at least two weeks ahead for anything longer than three days. Your manager approves within two business days.

## Carry-over

Up to 5 unused days carry into the next year and expire on March 31.
`,
    },
    // --------------------------------------------------------------- Support
    {
      slug: 'refund-and-warranty-policy',
      title: 'Refund & Warranty Policy',
      folder: 'Support',
      owner: 'priya',
      days: 300,
      body: `## Refunds (software)

Refund windows are defined on the pricing sheet in the Sales folder. Support applies them as written; escalate edge cases to the Head of Support.

## Hardware warranty

${Q.C03_A} The warranty covers manufacturing defects in the arm, gripper, and controller.
${Q.X09_A}

## Warranty replacements

${Q.C24_A} Replacement units ship within 5 business days of RMA approval.

## Exclusions

Consumables (suction cups, gripper pads) are not covered after the first 90 days.
`,
    },
    {
      slug: 'sla',
      title: 'Support SLA',
      folder: 'Support',
      owner: 'priya',
      days: 250,
      body: `## Response targets

${Q.C02_A}
P1 (fleet down): response within 30 minutes during support hours.
${Q.X01_A}

## Support hours

${Q.C09_B} Enterprise customers can purchase extended coverage.

## Channels

Email support@northwindrobotics.example or open a ticket from the control plane.
`,
    },
    {
      slug: 'support-escalation-matrix',
      title: 'Support Escalation Matrix',
      folder: 'Support',
      owner: 'priya',
      days: 120,
      body: `## Tiers

- Tier 1: support engineers handle known issues using macros.
- Tier 2: senior support reproduces and gathers logs.
- Tier 3: engineering owner for the affected service.

## Service owners

- control-plane: Platform team
- fleet-agent: Platform team
- billing-service: Billing team

## Notes

Always attach the ticket link when escalating in #support.
`,
    },
    // ----------------------------------------------------------------- Sales
    {
      slug: 'pricing-sheet',
      title: 'Pricing Sheet 2026',
      folder: 'Sales',
      owner: 'sofia',
      days: 150,
      body: `## Tiers

| Tier | Price per robot / month | Seats included |
|---|---|---|
| Starter | $390 | 5 |
| Growth | $340 | 20 |
| Enterprise | custom | 50+ |

${Q.C06_A} Growth requires a minimum of 10 seats.

## Terms

${Q.C25_A}
${Q.C01_A}
Annual prepay receives an 8% discount.
`,
    },
    {
      slug: 'sales-one-pager',
      title: 'Northwind Picking Arm — Sales One-Pager',
      folder: 'Sales',
      owner: 'sofia',
      days: 330,
      body: `## Why Northwind

Faster picks, fewer errors, and a control plane your team will actually use.

## Highlights

- ${Q.X03_B}
- 99.5% pick accuracy in customer deployments.
- ${Q.C03_B}
- Deploys in under two weeks per site.
`,
    },
    {
      slug: 'sales-playbook',
      title: 'Sales Playbook',
      folder: 'Sales',
      owner: 'sofia',
      days: 280,
      body: `## Discounting

${Q.C13_A} Larger discounts require Head of Sales approval in writing.

## Pilots

${Q.C20_A} Pilots run 6 to 8 weeks with a named customer sponsor.

## Handoffs

After close, introduce the customer to Support in a shared channel within 48 hours.
`,
    },
    {
      slug: 'legal-one-pager-pilots',
      title: 'Legal One-Pager: Pilots',
      folder: 'Sales',
      owner: 'rosa',
      days: 90,
      body: `## Paperwork for pilots

${Q.C20_B} Larger pilots use the standard mutual NDA plus the pilot order form.

## Data

Pilot telemetry is covered by the standard DPA. No custom data terms for pilots.
`,
    },
    {
      slug: 'crm-export-q1-2026',
      title: 'CRM Export — Q1 2026 Accounts',
      folder: 'Sales',
      owner: 'raj',
      days: 160,
      body: `## Enterprise accounts

${Q.C17_A}
Globex Distribution | Owner: Raj Mehta (AE) | Tier: Enterprise | Robots: 210
Vantage Systems | Owner: Hannah Kim (AE) | Tier: Enterprise | Robots: 40
Meridian Freight | Owner: Diego Alvarez (AE) | Tier: Enterprise | Robots: 65
Orion Parcel | Owner: Raj Mehta (AE) | Tier: Enterprise | Robots: 150
Kestrel Automotive | Owner: Hannah Kim (AE) | Tier: Enterprise | Robots: 88

## Growth accounts

${CUSTOMERS.filter((c) => c.tier === 'Growth')
  .map((c) => `${c.name} | Owner: ${person(c.owner).name} (AE) | Tier: Growth | Robots: ${c.robots}`)
  .join('\n')}
`,
    },
    // ------------------------------------------------------------- Marketing
    {
      slug: 'website-copy',
      title: 'Website Copy (current)',
      folder: 'Marketing',
      owner: 'grace',
      days: 210,
      body: `## Hero

Warehouse picking, on autopilot.

## Trial

${Q.C07_A} ${Q.X05_A}

## Support

${Q.C02_B}
`,
    },
    {
      slug: 'onboarding-email-templates',
      title: 'Onboarding Email Templates',
      folder: 'Marketing',
      owner: 'grace',
      days: 240,
      body: `## Welcome email

Subject: Welcome to Northwind

${Q.C07_B} ${Q.X05_B} Reply to this email if you need anything.

## Day 7 check-in

Subject: How is your first week going?

We noticed you registered your first robot. Want a 20-minute walkthrough of the fleet page?
`,
    },
    {
      slug: 'status-page-copy',
      title: 'Status Page Copy',
      folder: 'Marketing',
      owner: 'carlos',
      days: 170,
      body: `## Maintenance

${Q.C18_A} Customers are notified 72 hours ahead.

## Incident template

We are investigating reports of [symptom]. Updates every 30 minutes.
`,
    },
    // --------------------------------------------------------------- Product
    {
      slug: 'product-one-pager',
      title: 'Product One-Pager',
      folder: 'Product',
      owner: 'ivan',
      days: 260,
      body: `## Control plane

Fleet management, pick orchestration, and telemetry for every robot on the floor.

## Scale

${Q.X11_A}

## Firmware

${Q.C19_A} Customers choose the stable or canary channel per site.
`,
    },
    {
      slug: 'product-batch-pick-beta',
      title: 'Batch-Pick Beta',
      folder: 'Product',
      owner: 'ivan',
      days: 350,
      body: `## What it does

Batch-pick groups orders sharing an aisle so one arm completes several picks per pass.

## Availability

${Q.D11_DOC}

## Known limitations

Cold-chain sites are excluded from the beta.
`,
    },
    {
      slug: 'okrs-h1-2026',
      title: 'OKRs H1 2026',
      folder: 'Product',
      owner: 'alice',
      days: 180,
      body: `## Objective 1: Make every pick count

- KR: Pick accuracy ≥ 99.6% across the fleet
- KR: Batch-pick enabled at 40% of Growth sites

## Objective 2: Land in Europe

- KR: 5 EU customers live
- KR: EU data residency complete

## Objective 3: Support that scales

- KR: Median first response under target on every plan
`,
    },
    {
      slug: 'hardware-spec-sheet',
      title: 'Hardware Spec Sheet — Picking Arm v3',
      folder: 'Product',
      owner: 'nina',
      days: 300,
      body: `## Mechanical

- Reach: 1.4 m
- ${Q.X03_A}
- Cycle time: 3.2 s typical

## Electrical

- 48 V DC input, 600 W peak
- Ethernet or Wi-Fi 6 to the fleet agent
`,
    },
    {
      slug: 'meeting-notes-product-sync',
      title: 'Meeting Notes — Product Sync',
      folder: 'Product',
      owner: 'ivan',
      days: 50,
      body: meetingNotes(rng, 'Product sync', ['ivan', 'grace', 'theo', 'jenna'], productPool),
    },
    // ----------------------------------------------------------- Engineering
    {
      slug: 'api-guide',
      title: 'Control Plane API Guide',
      folder: 'Engineering',
      owner: 'jenna',
      days: 380,
      body: `## Authentication

${Q.D01_DOC} Keys are issued per integration from the admin console.

## Limits

${Q.C10_A}
${Q.X11_B}

## Robots

${Q.D05_DOC}

## Errors

${Q.D09_DOC}

## SDK

\`\`\`ts
const client = new NorthwindClient({ apiKey });
${Q.D15_DOC}
\`\`\`

## Telemetry

${Q.C08_B}
`,
    },
    {
      slug: 'integrations-guide',
      title: 'Integrations Guide',
      folder: 'Engineering',
      owner: 'omar',
      days: 320,
      body: `## Webhooks

Subscribe to pick.completed, robot.offline, and invoice.paid events.
${Q.D10_DOC} Failed deliveries are visible in the admin console.

## Payload

Each payload includes the event id, occurred_at, and the resource snapshot.
`,
    },
    {
      slug: 'eng-handbook',
      title: 'Engineering Handbook',
      folder: 'Engineering',
      owner: 'jenna',
      days: 140,
      body: `## Languages and runtimes

TypeScript everywhere. ${Q.X02_A}

## Versioning

${Q.C22_A} Breaking changes bump the major version and get a migration note.

## Reviews

Every PR needs one approval from a CODEOWNER. Keep PRs under 400 lines where possible.
`,
    },
    {
      slug: 'deploy-guide',
      title: 'Deploy Guide',
      folder: 'Engineering',
      owner: 'jenna',
      days: 290,
      body: `## Process

${Q.X10_A} Tag the release, watch the dashboard for 15 minutes.

## Freeze

${Q.C11_A} Hotfixes need Platform Lead approval.

## Configuration

${Q.D06_DOC} Never run migrations from a laptop against production.
`,
    },
    {
      slug: 'meeting-notes-eng-weekly',
      title: 'Meeting Notes — Engineering Weekly',
      folder: 'Engineering',
      owner: 'jenna',
      days: 30,
      body: meetingNotes(rng, 'Engineering weekly', ['jenna', 'marcus', 'dev', 'lena', 'carlos'], engPool),
    },
    // -------------------------------------------------------------- Runbooks
    {
      slug: 'runbook-incidents',
      title: 'Runbook: Incidents',
      folder: 'Runbooks',
      owner: 'carlos',
      days: 310,
      body: `## Severity

P1: fleet down or data loss. P2: degraded picking. P3: cosmetic.

## Paging

${Q.C14_A} For P2, post in #incidents and page on-call if unacknowledged after 30 minutes.

## Rotation

${Q.C12_A}
${Q.X12_B}

## Postmortems

Every P1 gets a written postmortem within 5 business days.
`,
    },
    {
      slug: 'runbook-disaster-recovery',
      title: 'Runbook: Disaster Recovery',
      folder: 'Runbooks',
      owner: 'carlos',
      days: 270,
      body: `## Backups

${Q.C16_A} Snapshots are retained for 35 days.

## Restore procedure

1. Provision a fresh Postgres instance from the latest AMI.
2. ${Q.D13_DOC}
3. Point control-plane at the restored instance and run smoke tests.
`,
    },
    {
      slug: 'runbook-billing-ops',
      title: 'Runbook: Billing Operations',
      folder: 'Runbooks',
      owner: 'marcus',
      days: 230,
      body: `## Invoice runs

Invoices generate on the 1st of each month at 06:00 UTC. ${Q.X08_A}

## Failed payments

${Q.D04_DOC} Uncollectible invoices go to the dunning queue.

## Manual adjustments

Credits require a ticket reference and Finance approval above $1,000.
`,
    },
    {
      slug: 'runbook-maintenance-window',
      title: 'Runbook: Maintenance Window',
      folder: 'Runbooks',
      owner: 'carlos',
      days: 130,
      body: `## Schedule

${Q.C18_B} Post the plan in #eng by Thursday.

## Checklist

- Announce on the status page
- Drain the pick queues
- Apply upgrades, run smoke tests
- Close the status page notice
`,
    },
    {
      slug: 'runbook-fleet-agent-install',
      title: 'Runbook: Fleet Agent Install',
      folder: 'Runbooks',
      owner: 'dev',
      days: 340,
      body: `## Install

Install the fleet-agent package on the site gateway and register it with the control plane using the site token.

## Networking

${Q.D12_DOC} Open it inbound from the robot VLAN only.

## Verify

The fleet page shows the site as online within two minutes.
`,
    },
    {
      slug: 'runbook-database-access',
      title: 'Runbook: Database Access',
      folder: 'Runbooks',
      owner: 'carlos',
      days: 110,
      body: `## Read access

Request a read-only role via the #eng access request form. Access expires after 30 days.

## Write access

Production writes go through migrations only. Emergency writes need two engineers on the call.
`,
    },
    // -------------------------------------------------------------- Security
    {
      slug: 'security-policy',
      title: 'Security Policy',
      folder: 'Security',
      owner: 'jenna',
      days: 200,
      body: `## Infrastructure

${Q.X04_A} All data is encrypted at rest and in transit.

## Backups

${Q.C16_B} Restores are tested quarterly.

## Access

${Q.C15_A} MFA is mandatory for every account.

## Data retention

${Q.C08_A}
`,
    },
    {
      slug: 'it-onboarding',
      title: 'IT Onboarding',
      folder: 'Security',
      owner: 'kai',
      days: 70,
      body: `## Accounts

You sign in to everything with SSO. ${Q.C15_B}

## Devices

Laptops are enrolled in MDM on day one. Disk encryption is enforced.
`,
    },
    // ------------------------------------------------------------------- Ops
    {
      slug: 'expense-policy',
      title: 'Expense Policy',
      folder: 'Ops',
      owner: 'elif',
      days: 220,
      body: `## Limits

${Q.C05_A} Anything above that needs manager approval in the expense tool.

## Travel

${Q.C23_A} Economy for flights under 6 hours.

## Reimbursement

Submit within 30 days of the expense. Reimbursements pay out with the next payroll run.
`,
    },
    // --------------------------------------------------------------- General
    {
      slug: 'glossary',
      title: 'Glossary',
      folder: 'General',
      owner: 'ivan',
      days: 80,
      body: `- **Site**: a customer warehouse running one fleet agent.
- **Fleet agent**: the on-site daemon that brokers between robots and the control plane.
- **Pick**: one item moved from a bin to an order tote.
- **Batch-pick**: several picks completed in one aisle pass.
- **RMA**: return merchandise authorization for hardware replacement.
- **Canary channel**: early firmware channel for opted-in sites.
`,
    },
    {
      slug: 'all-hands-notes-2026-06',
      title: 'All-Hands Notes — June 2026',
      folder: 'General',
      owner: 'alice',
      days: 75,
      body: `## Highlights

- 200 customers, 5 in the EU.
- Batch-pick GA shipped; adoption climbing.
- Support hiring: two new support engineers start in July.

## Q&A

Q: When is the next offsite? A: October, location to be announced.
`,
    },
    // ------------------------------------------------------ Finance-restricted
    {
      slug: 'pricing-increase-plan-q4',
      title: 'Pricing Increase Plan — Q4',
      folder: 'Finance-Restricted',
      restricted: 'finance',
      owner: 'tom',
      days: 40,
      body: `## Plan

${Q.P03_DOC}

## Rollout

Sales gets talking points on October 10. Existing contracts renew at the new list price unless otherwise agreed.
`,
    },
    {
      slug: 'postmortem-inc-2077-customer-data-exposure',
      title: 'Postmortem: inc-2077 (customer data exposure)',
      folder: 'Finance-Restricted',
      restricted: 'finance',
      owner: 'jenna',
      days: 150,
      body: `## Summary

${Q.P04_DOC}

## Timeline

March 9: reported by a customer admin. March 9: signed URLs scoped per tenant, rotated. March 12: affected customers notified under NDA.

## Follow-ups

- Tenant scoping test added to the billing-service suite
- Legal to track NDA obligations
`,
    },
    {
      slug: 'board-financials-fy26',
      title: 'Board Financials — FY26',
      folder: 'Finance-Restricted',
      restricted: 'finance',
      owner: 'tom',
      days: 20,
      body: `## Summary

ARR $14.2M, up 41% year over year. Gross margin 61%. Cash runway 26 months.

## Notes

Hardware margin improved 4 points after the Reno depot consolidation.
`,
    },
    // --------------------------------------------------------- Exec-restricted
    {
      slug: 'compensation-bands-2026',
      title: 'Compensation Bands 2026',
      folder: 'Exec-Restricted',
      restricted: 'exec',
      owner: 'alice',
      days: 45,
      body: `## Bands

${Q.P01_DOC}
Support L3 band: $92,000 to $118,000.

## Process

Managers receive individual numbers on September 20.
`,
    },
    {
      slug: 'scenario-planning-rif',
      title: 'Scenario Planning — Reduction in Force',
      folder: 'Exec-Restricted',
      restricted: 'exec',
      owner: 'alice',
      days: 35,
      body: `## Scenarios

Scenario A: hiring freeze only.
${Q.P05_DOC}

## Triggers

Reviewed monthly against the board plan.
`,
    },
  ];

  if (defs.length !== 40) throw new Error(`expected 40 docs, defined ${defs.length}`);

  return defs.map((d, i) => ({
    id: `doc_${String(i + 1).padStart(4, '0')}`,
    slug: d.slug,
    title: d.title,
    folder: d.folder,
    path: `drive/${d.folder}/${d.slug}.md`,
    restricted: d.restricted ?? 'none',
    owner: d.owner,
    modifiedAt: daysAgo(d.days, rng.int(8, 18), rng.int(0, 59)),
    body: h(d.title, d.owner, d.days) + '\n' + d.body,
  }));
}
