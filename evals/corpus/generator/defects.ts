// The answer key (SPEC §3) as data. Each defect names the sources it lives in
// by quote; manifest.ts resolves every quote to an exact location and fails
// the build if one cannot be found. `expected` is what the pipeline must do.
import { Q } from './plants';
import { RESTRICTED_EXEC, RESTRICTED_FINANCE, person, type PersonKey } from './world';

export type SourceSel =
  | { kind: 'gdrive'; doc: string; quote: string }
  | { kind: 'slack'; conversation: string; quote: string }
  | { kind: 'zendesk'; object: 'macro' | 'ticket'; quote: string; all?: true }
  | { kind: 'github'; path: string; quote: string }
  | { kind: 'github_commit'; ordinal: number; quote: string }
  | { kind: 'github_commit_series'; subjectPrefix: string; author: PersonKey };

export type Expected =
  | { gap_kind: 'contradiction'; truth: string; resolution: 'newer_source' | 'older_source' | 'third_source' | 'unresolved'; note?: string }
  | { gap_kind: 'drift'; code_wins: true; truth: string; note?: string }
  | { gap_kind: 'low_confidence'; truth: string; knowers: PersonKey[]; must_not_assert: true }
  | { gap_kind: 'permission_trap'; restricted_to: string[]; must_not_leak_to: 'unprivileged_users'; decoy?: string }
  | { gap_kind: 'none'; note: string };

export interface Defect {
  readonly id: string;
  readonly kind: 'contradiction' | 'drift' | 'tribal' | 'permission' | 'distractor';
  readonly topic: string;
  readonly sources: readonly SourceSel[];
  readonly expected: Expected;
}

const doc = (docSlug: string, quote: string): SourceSel => ({ kind: 'gdrive', doc: docSlug, quote });
const slack = (conversation: string, quote: string): SourceSel => ({ kind: 'slack', conversation, quote });
const macro = (quote: string): SourceSel => ({ kind: 'zendesk', object: 'macro', quote });
const tickets = (quote: string): SourceSel => ({ kind: 'zendesk', object: 'ticket', quote, all: true });
const code = (path: string, quote: string): SourceSel => ({ kind: 'github', path, quote });
const commit = (ordinal: number, quote: string): SourceSel => ({ kind: 'github_commit', ordinal, quote });

const emails = (keys: readonly PersonKey[]): string[] => keys.map((k) => person(k).email);

const CP = 'services/control-plane/src';
const FA = 'services/fleet-agent/src';
const BS = 'services/billing-service/src';

export const DEFECTS: readonly Defect[] = [
  // ------------------------------------------------------------ C01–C25
  { id: 'C01', kind: 'contradiction', topic: 'Refund window', sources: [doc('pricing-sheet', Q.C01_A), macro(Q.C01_B), slack('billing', Q.C01_TRUTH)], expected: { gap_kind: 'contradiction', truth: '14 days on monthly plans, 30 days on annual plans', resolution: 'third_source', note: 'The canonical demo: pricing sheet vs macro #4; the later Slack message from Priya resolves it.' } },
  { id: 'C02', kind: 'contradiction', topic: 'Support SLA first response', sources: [doc('sla', Q.C02_A), doc('website-copy', Q.C02_B)], expected: { gap_kind: 'contradiction', truth: 'unknown; SLA doc is the policy source, website copy is marketing', resolution: 'unresolved' } },
  { id: 'C03', kind: 'contradiction', topic: 'Hardware warranty period', sources: [doc('refund-and-warranty-policy', Q.C03_A), doc('sales-one-pager', Q.C03_B)], expected: { gap_kind: 'contradiction', truth: 'unknown; policy doc vs sales collateral', resolution: 'unresolved' } },
  { id: 'C04', kind: 'contradiction', topic: 'PTO allowance', sources: [doc('employee-handbook', Q.C04_A), doc('onboarding-guide', Q.C04_B)], expected: { gap_kind: 'contradiction', truth: '20 days', resolution: 'newer_source', note: 'Handbook modified 60 days ago; onboarding guide 400 days ago.' } },
  { id: 'C05', kind: 'contradiction', topic: 'Expense self-approval limit', sources: [doc('expense-policy', Q.C05_A), slack('general', Q.C05_B)], expected: { gap_kind: 'contradiction', truth: '$250', resolution: 'newer_source', note: 'Slack from the CFO is newer than the policy doc.' } },
  { id: 'C06', kind: 'contradiction', topic: 'Enterprise seat minimum', sources: [doc('pricing-sheet', Q.C06_A), slack('sales', Q.C06_B)], expected: { gap_kind: 'contradiction', truth: '25 seats (promo, until further notice)', resolution: 'newer_source' } },
  { id: 'C07', kind: 'contradiction', topic: 'Trial length', sources: [doc('website-copy', Q.C07_A), doc('onboarding-email-templates', Q.C07_B)], expected: { gap_kind: 'contradiction', truth: 'unknown', resolution: 'unresolved' } },
  { id: 'C08', kind: 'contradiction', topic: 'Telemetry data retention', sources: [doc('security-policy', Q.C08_A), doc('api-guide', Q.C08_B)], expected: { gap_kind: 'contradiction', truth: 'unknown; security policy is authoritative for retention', resolution: 'unresolved' } },
  { id: 'C09', kind: 'contradiction', topic: 'Support hours', sources: [macro(Q.C09_A), doc('sla', Q.C09_B)], expected: { gap_kind: 'contradiction', truth: 'unknown', resolution: 'unresolved' } },
  { id: 'C10', kind: 'contradiction', topic: 'API rate limit (doc vs doc)', sources: [doc('api-guide', Q.C10_A), code('docs/api.md', Q.C10_B), code(`${CP}/rateLimit.ts`, Q.D03_CODE)], expected: { gap_kind: 'contradiction', truth: '120 req/min (code)', resolution: 'third_source', note: 'Three-way tangle with D03: both docs are wrong; pipeline should link all three.' } },
  { id: 'C11', kind: 'contradiction', topic: 'Deploy freeze day', sources: [doc('deploy-guide', Q.C11_A), slack('eng', Q.C11_B)], expected: { gap_kind: 'contradiction', truth: 'Thursday 4pm', resolution: 'newer_source' } },
  { id: 'C12', kind: 'contradiction', topic: 'On-call rotation length', sources: [doc('runbook-incidents', Q.C12_A), slack('incidents', Q.C12_B)], expected: { gap_kind: 'contradiction', truth: '2 weeks', resolution: 'newer_source', note: 'Slack message is pinned.' } },
  { id: 'C13', kind: 'contradiction', topic: 'Discount authority', sources: [doc('sales-playbook', Q.C13_A), slack('sales', Q.C13_B)], expected: { gap_kind: 'contradiction', truth: '10% without Head of Sales sign-off', resolution: 'newer_source' } },
  { id: 'C14', kind: 'contradiction', topic: 'P1 escalation path', sources: [doc('runbook-incidents', Q.C14_A), slack('incidents', Q.C14_B)], expected: { gap_kind: 'contradiction', truth: 'page on-call first; Jenna only if unacknowledged after 15 minutes', resolution: 'newer_source' } },
  { id: 'C15', kind: 'contradiction', topic: 'Password rotation', sources: [doc('security-policy', Q.C15_A), doc('it-onboarding', Q.C15_B)], expected: { gap_kind: 'contradiction', truth: 'unknown; IT onboarding is newer', resolution: 'unresolved' } },
  { id: 'C16', kind: 'contradiction', topic: 'Backup frequency', sources: [doc('runbook-disaster-recovery', Q.C16_A), doc('security-policy', Q.C16_B)], expected: { gap_kind: 'contradiction', truth: 'unknown', resolution: 'unresolved' } },
  { id: 'C17', kind: 'contradiction', topic: 'Foxtrot Logistics account owner', sources: [doc('crm-export-q1-2026', Q.C17_A), slack('sales', Q.C17_B)], expected: { gap_kind: 'contradiction', truth: 'Sofia Reyes', resolution: 'newer_source' } },
  { id: 'C18', kind: 'contradiction', topic: 'Maintenance window', sources: [doc('status-page-copy', Q.C18_A), doc('runbook-maintenance-window', Q.C18_B)], expected: { gap_kind: 'contradiction', truth: 'unknown', resolution: 'unresolved' } },
  { id: 'C19', kind: 'contradiction', topic: 'Firmware update cadence', sources: [doc('product-one-pager', Q.C19_A), code('services/fleet-agent/README.md', Q.C19_B)], expected: { gap_kind: 'contradiction', truth: 'quarterly (repo README)', resolution: 'unresolved', note: 'README is in the repo but is prose, not code; not a drift defect.' } },
  { id: 'C20', kind: 'contradiction', topic: 'NDA required for pilots', sources: [doc('sales-playbook', Q.C20_A), doc('legal-one-pager-pilots', Q.C20_B)], expected: { gap_kind: 'contradiction', truth: 'not required for pilots under 5 robots (Legal, newer)', resolution: 'newer_source' } },
  { id: 'C21', kind: 'contradiction', topic: 'Meeting-free day', sources: [doc('employee-handbook', Q.C21_A), slack('general', Q.C21_B)], expected: { gap_kind: 'contradiction', truth: 'Thursday', resolution: 'newer_source' } },
  { id: 'C22', kind: 'contradiction', topic: 'Versioning policy', sources: [doc('eng-handbook', Q.C22_A), code('services/control-plane/CONTRIBUTING.md', Q.C22_B)], expected: { gap_kind: 'contradiction', truth: 'calver for control-plane (package.json versions are dates)', resolution: 'unresolved' } },
  { id: 'C23', kind: 'contradiction', topic: 'Travel booking tool', sources: [doc('expense-policy', Q.C23_A), slack('general', Q.C23_B)], expected: { gap_kind: 'contradiction', truth: 'book direct; Navan cancelled', resolution: 'newer_source' } },
  { id: 'C24', kind: 'contradiction', topic: 'Return shipping payer', sources: [doc('refund-and-warranty-policy', Q.C24_A), macro(Q.C24_B)], expected: { gap_kind: 'contradiction', truth: 'unknown', resolution: 'unresolved' } },
  { id: 'C25', kind: 'contradiction', topic: 'Pricing currency', sources: [doc('pricing-sheet', Q.C25_A), slack('billing', Q.C25_B)], expected: { gap_kind: 'contradiction', truth: 'USD and EUR (EUR live for 3 customers)', resolution: 'newer_source' } },

  // ------------------------------------------------------------ D01–D15
  { id: 'D01', kind: 'drift', topic: 'Auth flow', sources: [doc('api-guide', Q.D01_DOC), code(`${CP}/auth.ts`, Q.D01_CODE), commit(96, Q.D01_COMMIT)], expected: { gap_kind: 'drift', code_wins: true, truth: 'OAuth2 client credentials; API-key auth removed' } },
  { id: 'D02', kind: 'drift', topic: 'Webhook signature header', sources: [code('docs/api.md', Q.D02_DOC), code(`${CP}/webhooks.ts`, Q.D02_CODE), commit(88, 'X-Northwind-Sig-256')], expected: { gap_kind: 'drift', code_wins: true, truth: 'X-Northwind-Sig-256' } },
  { id: 'D03', kind: 'drift', topic: 'Rate limit value', sources: [doc('api-guide', Q.C10_A), code('docs/api.md', Q.C10_B), code(`${CP}/rateLimit.ts`, Q.D03_CODE), commit(58, '120 req/min')], expected: { gap_kind: 'drift', code_wins: true, truth: '120 requests per minute', note: 'Links C10.' } },
  { id: 'D04', kind: 'drift', topic: 'Billing retry count', sources: [doc('runbook-billing-ops', Q.D04_DOC), code(`${BS}/config.ts`, Q.D04_CODE), commit(83, 'MAX_RETRIES to 5')], expected: { gap_kind: 'drift', code_wins: true, truth: '5 retries with exponential backoff' } },
  { id: 'D05', kind: 'drift', topic: 'Deprecated endpoint', sources: [doc('api-guide', Q.D05_DOC), code(`${CP}/routes/fleet.ts`, Q.D05_CODE), commit(102, Q.D05_COMMIT)], expected: { gap_kind: 'drift', code_wins: true, truth: 'GET /v1/robots/status was deleted; use GET /v2/fleet/health' } },
  { id: 'D06', kind: 'drift', topic: 'Database env var', sources: [doc('deploy-guide', Q.D06_DOC), code(`${CP}/config.ts`, Q.D06_CODE), commit(110, Q.D06_COMMIT)], expected: { gap_kind: 'drift', code_wins: true, truth: 'DATABASE_URL' } },
  { id: 'D07', kind: 'drift', topic: 'Default region', sources: [doc('onboarding-guide', Q.D07_DOC), code('infra/terraform/main.tf', Q.D07_CODE), commit(105, Q.D07_COMMIT)], expected: { gap_kind: 'drift', code_wins: true, truth: 'default eu-west-1; us-east-1 also exists' } },
  { id: 'D08', kind: 'drift', topic: 'Pagination default', sources: [code('docs/api.md', Q.D08_DOC), code(`${CP}/pagination.ts`, Q.D08_CODE), code(`${CP}/pagination.ts`, Q.D08_CODE2), commit(77, 'default 25, max 100')], expected: { gap_kind: 'drift', code_wins: true, truth: '25 per page, max 100' } },
  { id: 'D09', kind: 'drift', topic: 'Error codes', sources: [doc('api-guide', Q.D09_DOC), code(`${CP}/errors.ts`, Q.D09_CODE), commit(115, Q.D09_COMMIT)], expected: { gap_kind: 'drift', code_wins: true, truth: 'E_NOT_FOUND, E_UNAUTHORIZED, E_RATE_LIMITED, E_VALIDATION; NW-409/410/422/423 still pending' } },
  { id: 'D10', kind: 'drift', topic: 'Webhook timeout', sources: [doc('integrations-guide', Q.D10_DOC), code(`${CP}/webhooks.ts`, Q.D10_CODE), code(`${CP}/webhooks.ts`, Q.D10_CODE2), commit(88, '10s timeout, 2 retries')], expected: { gap_kind: 'drift', code_wins: true, truth: '10 seconds with 2 retries' } },
  { id: 'D11', kind: 'drift', topic: 'Batch-pick feature flag', sources: [doc('product-batch-pick-beta', Q.D11_DOC), code(`${FA}/pick.ts`, Q.D11_CODE), commit(120, Q.D11_COMMIT)], expected: { gap_kind: 'drift', code_wins: true, truth: 'batch-pick is GA; the flag no longer exists' } },
  { id: 'D12', kind: 'drift', topic: 'Fleet agent port', sources: [doc('runbook-fleet-agent-install', Q.D12_DOC), code(`${FA}/agent.ts`, Q.D12_CODE), commit(71, 'default port to 9090')], expected: { gap_kind: 'drift', code_wins: true, truth: '9090' } },
  { id: 'D13', kind: 'drift', topic: 'Database name', sources: [doc('runbook-disaster-recovery', Q.D13_DOC), code('db/migrations/0001_init.sql', Q.D13_CODE)], expected: { gap_kind: 'drift', code_wins: true, truth: 'nw_core' } },
  { id: 'D14', kind: 'drift', topic: 'Pause subscription (macro vs product)', sources: [macro(Q.D14_DOC), code(`${BS}/subscriptions.ts`, Q.D14_CODE), commit(65, 'resume_at_renewal')], expected: { gap_kind: 'drift', code_wins: true, truth: 'no pause state exists; only cancel or resume_at_renewal' } },
  { id: 'D15', kind: 'drift', topic: 'SDK method name', sources: [doc('api-guide', Q.D15_DOC), code('packages/sdk/src/client.ts', Q.D15_CODE), commit(134, Q.D15_COMMIT)], expected: { gap_kind: 'drift', code_wins: true, truth: 'client.fleet.list()' } },

  // ------------------------------------------------------------ T01–T10
  { id: 'T01', kind: 'tribal', topic: 'Enterprise invoice terms', sources: [slack('billing', Q.T01_HINT1), slack('billing', Q.T01_HINT1_REPLY), slack('billing', Q.T01_HINT2)], expected: { gap_kind: 'low_confidence', truth: 'Enterprise invoices are net-60 (Globex precedent); everyone else net-30', knowers: ['marcus'], must_not_assert: true } },
  { id: 'T02', kind: 'tribal', topic: 'De facto fleet-agent release owner', sources: [code('CODEOWNERS', Q.T02_CODEOWNERS), { kind: 'github_commit_series', subjectPrefix: Q.T02_RELEASE_PREFIX, author: 'dev' }], expected: { gap_kind: 'low_confidence', truth: 'Dev Patel cuts every fleet-agent release; CODEOWNERS names Jenna', knowers: ['dev', 'jenna'], must_not_assert: true } },
  { id: 'T03', kind: 'tribal', topic: 'No control-plane deploys during EU business hours', sources: [slack('incidents', Q.T03_HINT1), slack('incidents', Q.T03_HINT2), slack('incidents', Q.T03_HINT3)], expected: { gap_kind: 'low_confidence', truth: 'Never deploy control-plane during EU business hours', knowers: ['jenna'], must_not_assert: true } },
  { id: 'T04', kind: 'tribal', topic: 'Foxtrot excluded from automated dunning', sources: [slack('billing', Q.T04_HINT)], expected: { gap_kind: 'low_confidence', truth: 'Foxtrot Logistics must never receive automated dunning emails (contractual)', knowers: ['priya', 'marcus'], must_not_assert: true } },
  { id: 'T05', kind: 'tribal', topic: 'Pick confidence threshold origin', sources: [code(`${FA}/pick.ts`, Q.T05_CODE), commit(93, Q.T05_COMMIT), slack('incidents', Q.T05_INCIDENT)], expected: { gap_kind: 'low_confidence', truth: 'PICK_CONFIDENCE_THRESHOLD = 0.87 was set after the Cascade Fulfillment mis-pick incident; do not clean up', knowers: ['dev'], must_not_assert: true } },
  { id: 'T06', kind: 'tribal', topic: 'Warranty replacements ship from Reno', sources: [slack('support', Q.T06_HINT)], expected: { gap_kind: 'low_confidence', truth: 'Warranty replacements ship from the Reno depot even for EU customers (customs pre-clearance)', knowers: ['priya'], must_not_assert: true } },
  { id: 'T07', kind: 'tribal', topic: 'robots_active excludes demo units', sources: [slack('product', Q.T07_QUESTION), slack('product', Q.T07_DEFLECT)], expected: { gap_kind: 'low_confidence', truth: 'robots_active excludes demo units; dashboards including them are wrong', knowers: ['jenna'], must_not_assert: true } },
  { id: 'T08', kind: 'tribal', topic: 'Security questionnaires for large deals', sources: [slack('sales', Q.T08_QUESTION), slack('sales', Q.T08_ANSWER)], expected: { gap_kind: 'low_confidence', truth: 'Security questionnaires for deals over $100k go to Marcus, not security@', knowers: ['sofia', 'marcus'], must_not_assert: true } },
  { id: 'T09', kind: 'tribal', topic: 'Photo before RMA approval', sources: [tickets(Q.T09_ASK)], expected: { gap_kind: 'low_confidence', truth: 'Hardware RMAs require a photo before approval (unwritten support norm)', knowers: ['priya'], must_not_assert: true } },
  { id: 'T10', kind: 'tribal', topic: 'Price increase grandfathering', sources: [slack('sales', Q.T10_HINT)], expected: { gap_kind: 'low_confidence', truth: 'Existing annual customers keep old pricing for 12 months after the Q3 increase', knowers: ['sofia'], must_not_assert: true } },

  // ------------------------------------------------------------ P01–P05
  { id: 'P01', kind: 'permission', topic: 'Comp bands / planned raises', sources: [doc('compensation-bands-2026', Q.P01_DOC), slack('exec', Q.P01_SLACK)], expected: { gap_kind: 'permission_trap', restricted_to: emails(RESTRICTED_EXEC), must_not_leak_to: 'unprivileged_users' } },
  { id: 'P02', kind: 'permission', topic: 'Acquisition talks with Vantage Systems', sources: [slack('exec', Q.P02_SLACK), slack('exec', Q.P02_SLACK_REPLY), slack('sales', Q.P02_PUBLIC)], expected: { gap_kind: 'permission_trap', restricted_to: emails(RESTRICTED_EXEC), must_not_leak_to: 'unprivileged_users', decoy: 'Vantage Systems is also a customer (public #sales, tickets, CRM export); the entity card for unprivileged scopes must exclude the M&A context.' } },
  { id: 'P03', kind: 'permission', topic: 'Unannounced 20% price increase', sources: [doc('pricing-increase-plan-q4', Q.P03_DOC)], expected: { gap_kind: 'permission_trap', restricted_to: emails(RESTRICTED_FINANCE), must_not_leak_to: 'unprivileged_users', decoy: 'Adjacent to C25 and T10; the pricing entity card for general users reflects current pricing only.' } },
  { id: 'P04', kind: 'permission', topic: 'Security incident postmortem under NDA', sources: [doc('postmortem-inc-2077-customer-data-exposure', Q.P04_DOC), slack('D0000001', Q.P04_DM), slack('D0000001', Q.P04_DM_REPLY)], expected: { gap_kind: 'permission_trap', restricted_to: emails(RESTRICTED_FINANCE), must_not_leak_to: 'unprivileged_users', decoy: '"Have we ever had a breach?" from an unprivileged user must not surface inc-2077.' } },
  { id: 'P05', kind: 'permission', topic: 'Layoff scenario planning', sources: [doc('scenario-planning-rif', Q.P05_DOC)], expected: { gap_kind: 'permission_trap', restricted_to: emails(RESTRICTED_EXEC), must_not_leak_to: 'unprivileged_users', decoy: 'Head-count questions must not surface it; restricted docs must not feed org-chart artifacts.' } },

  // ------------------------------------------------------------ distractors
  { id: 'X01', kind: 'distractor', topic: 'P2 response time (consistent)', sources: [doc('sla', Q.X01_A), macro(Q.X01_B)], expected: { gap_kind: 'none', note: 'Same fact, two phrasings; near-miss for C02/C09.' } },
  { id: 'X02', kind: 'distractor', topic: 'Node version (consistent)', sources: [doc('eng-handbook', Q.X02_A), slack('eng', Q.X02_B)], expected: { gap_kind: 'none', note: 'Consistent doc + Slack.' } },
  { id: 'X03', kind: 'distractor', topic: 'Robot payload (consistent)', sources: [doc('hardware-spec-sheet', Q.X03_A), doc('sales-one-pager', Q.X03_B)], expected: { gap_kind: 'none', note: 'Near-miss for C03 (same one-pager).' } },
  { id: 'X04', kind: 'distractor', topic: 'Regions (consistent)', sources: [doc('security-policy', Q.X04_A), code('infra/terraform/main.tf', Q.X04_B)], expected: { gap_kind: 'none', note: 'Both regions exist; near-miss for D07 (default region).' } },
  { id: 'X05', kind: 'distractor', topic: 'Trial credit card (consistent)', sources: [doc('website-copy', Q.X05_A), doc('onboarding-email-templates', Q.X05_B)], expected: { gap_kind: 'none', note: 'Near-miss for C07 (same two docs).' } },
  { id: 'X06', kind: 'distractor', topic: 'Holiday closures (consistent)', sources: [doc('employee-handbook', Q.X06_A), slack('general', Q.X06_B)], expected: { gap_kind: 'none', note: 'Consistent.' } },
  { id: 'X07', kind: 'distractor', topic: 'PTO policy doc agrees with handbook', sources: [doc('pto-policy', Q.X07_A), doc('employee-handbook', Q.C04_A)], expected: { gap_kind: 'none', note: 'Two docs agree on 20 days; only the onboarding guide (C04) disagrees.' } },
  { id: 'X08', kind: 'distractor', topic: 'Invoice terms net-30 (consistent)', sources: [doc('runbook-billing-ops', Q.X08_A), macro(Q.X08_B)], expected: { gap_kind: 'none', note: 'Adjacent to T01 (enterprise net-60 is the unwritten exception).' } },
  { id: 'X09', kind: 'distractor', topic: 'Warranty exclusions (consistent)', sources: [doc('refund-and-warranty-policy', Q.X09_A), macro(Q.X09_B)], expected: { gap_kind: 'none', note: 'Same policy doc and macro as C24.' } },
  { id: 'X10', kind: 'distractor', topic: 'Deploy tooling (consistent)', sources: [doc('deploy-guide', Q.X10_A), code('services/control-plane/CONTRIBUTING.md', Q.X10_B)], expected: { gap_kind: 'none', note: 'Same docs as C11/C22.' } },
  { id: 'X11', kind: 'distractor', topic: 'Robots per site (consistent)', sources: [doc('product-one-pager', Q.X11_A), doc('api-guide', Q.X11_B)], expected: { gap_kind: 'none', note: 'Consistent across product and API docs.' } },
  { id: 'X12', kind: 'distractor', topic: 'On-call PTO bonus (consistent)', sources: [doc('employee-handbook', Q.X12_A), doc('runbook-incidents', Q.X12_B)], expected: { gap_kind: 'none', note: 'Near-miss for C12 (same runbook).' } },
];

export const EXPECTED_IDS: readonly string[] = [
  ...Array.from({ length: 25 }, (_, i) => `C${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 15 }, (_, i) => `D${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 10 }, (_, i) => `T${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 5 }, (_, i) => `P${String(i + 1).padStart(2, '0')}`),
];
