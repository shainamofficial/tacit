// The fixed world of Northwind Robotics (SPEC §1): people, channels,
// customers, and the frozen clock every generator measures dates against.

export const SEED = 20260901;
/** The corpus "now": 2026-09-01T09:00:00Z. Dates span the 18 months before it. */
export const NOW = Date.UTC(2026, 8, 1, 9, 0, 0);
export const DOMAIN = 'northwindrobotics.example';
export const SPAN_DAYS = 548;

export type Team =
  | 'Engineering'
  | 'Support'
  | 'Sales'
  | 'Product'
  | 'Ops'
  | 'Finance'
  | 'Exec'
  | 'IT'
  | 'Legal';

export type PersonKey =
  | 'alice'
  | 'tom'
  | 'sofia'
  | 'jenna'
  | 'marcus'
  | 'dev'
  | 'priya'
  | 'raj'
  | 'lena'
  | 'omar'
  | 'yuki'
  | 'carlos'
  | 'nina'
  | 'sam'
  | 'maya'
  | 'ben'
  | 'aisha'
  | 'leo'
  | 'hannah'
  | 'diego'
  | 'zoe'
  | 'ivan'
  | 'grace'
  | 'noah'
  | 'elif'
  | 'theo'
  | 'kai'
  | 'rosa';

export interface Person {
  readonly key: PersonKey;
  readonly name: string;
  readonly first: string;
  /** GitHub-style handle, e.g. jenna-ortiz */
  readonly handle: string;
  readonly email: string;
  readonly slackId: string;
  readonly team: Team;
  readonly title: string;
}

const DEFS: ReadonlyArray<readonly [PersonKey, string, Team, string]> = [
  ['alice', 'Alice Chen', 'Exec', 'CEO'],
  ['tom', 'Tom Nakamura', 'Finance', 'CFO'],
  ['sofia', 'Sofia Reyes', 'Sales', 'Head of Sales'],
  ['jenna', 'Jenna Ortiz', 'Engineering', 'Platform Lead'],
  ['marcus', 'Marcus Webb', 'Engineering', 'Staff Engineer, Billing'],
  ['dev', 'Dev Patel', 'Engineering', 'Senior Engineer, Fleet'],
  ['priya', 'Priya Sharma', 'Support', 'Head of Support'],
  ['raj', 'Raj Mehta', 'Sales', 'Account Executive'],
  ['lena', 'Lena Fischer', 'Engineering', 'Software Engineer'],
  ['omar', 'Omar Haddad', 'Engineering', 'Software Engineer'],
  ['yuki', 'Yuki Tanaka', 'Engineering', 'Software Engineer'],
  ['carlos', 'Carlos Mendes', 'Engineering', 'Site Reliability Engineer'],
  ['nina', 'Nina Petrov', 'Engineering', 'Firmware Engineer'],
  ['sam', 'Sam Okafor', 'Engineering', 'Software Engineer'],
  ['maya', 'Maya Lindqvist', 'Support', 'Support Engineer'],
  ['ben', 'Ben Carter', 'Support', 'Support Engineer'],
  ['aisha', 'Aisha Rahman', 'Support', 'Support Engineer'],
  ['leo', 'Leo Moretti', 'Support', 'Support Engineer'],
  ['hannah', 'Hannah Kim', 'Sales', 'Account Executive'],
  ['diego', 'Diego Alvarez', 'Sales', 'Account Executive'],
  ['zoe', 'Zoe Walsh', 'Sales', 'Sales Development Rep'],
  ['ivan', 'Ivan Sokolov', 'Product', 'Product Manager'],
  ['grace', 'Grace Liu', 'Product', 'Product Designer'],
  ['noah', 'Noah Brennan', 'Ops', 'Head of Operations'],
  ['elif', 'Elif Demir', 'Finance', 'Finance Manager'],
  ['theo', 'Theo Baptiste', 'Product', 'Data Analyst'],
  ['kai', 'Kai Nakano', 'IT', 'IT Administrator'],
  ['rosa', 'Rosa Delgado', 'Legal', 'Legal Counsel'],
];

export const PEOPLE: readonly Person[] = DEFS.map(([key, name, team, title], i) => {
  const [first = '', last = ''] = name.split(' ');
  const handle = `${first}-${last}`.toLowerCase();
  return {
    key,
    name,
    first,
    handle,
    email: `${first}.${last}`.toLowerCase() + `@${DOMAIN}`,
    slackId: `U${String(i + 1).padStart(7, '0')}`,
    team,
    title,
  };
});

const BY_KEY = new Map(PEOPLE.map((p) => [p.key, p] as const));

export function person(key: PersonKey): Person {
  const p = BY_KEY.get(key);
  if (!p) throw new Error(`unknown person ${key}`);
  return p;
}

export function byTeam(team: Team): PersonKey[] {
  return PEOPLE.filter((p) => p.team === team).map((p) => p.key);
}

export const ENGINEERS = byTeam('Engineering');
export const SUPPORT = byTeam('Support');
export const SALES = byTeam('Sales');
export const EVERYONE: readonly PersonKey[] = PEOPLE.map((p) => p.key);

export interface Channel {
  readonly name: string;
  readonly id: string;
  readonly members: 'all' | readonly PersonKey[];
  readonly topic: string;
  readonly purpose: string;
}

export const CHANNELS: readonly Channel[] = [
  { name: 'general', id: 'C0000001', members: 'all', topic: 'Company-wide announcements', purpose: 'Everyone at Northwind' },
  { name: 'eng', id: 'C0000002', members: 'all', topic: 'Engineering', purpose: 'Deploys, PRs, platform chatter' },
  { name: 'support', id: 'C0000003', members: 'all', topic: 'Customer support', purpose: 'Escalations and support coordination' },
  { name: 'billing', id: 'C0000004', members: 'all', topic: 'Billing & invoicing', purpose: 'billing-service, invoices, dunning' },
  { name: 'product', id: 'C0000005', members: 'all', topic: 'Product', purpose: 'Roadmap, feedback, metrics' },
  { name: 'sales', id: 'C0000006', members: 'all', topic: 'Sales', purpose: 'Deals, pricing, playbook' },
  { name: 'incidents', id: 'C0000007', members: 'all', topic: 'Incidents & on-call', purpose: 'inc-NNNN coordination' },
  { name: 'exec', id: 'C0000008', members: ['alice', 'tom', 'sofia', 'jenna'], topic: 'Leadership', purpose: 'Exec team only' },
];

export function channel(name: string): Channel {
  const c = CHANNELS.find((ch) => ch.name === name);
  if (!c) throw new Error(`unknown channel ${name}`);
  return c;
}

/** The one DM in the export: Jenna ⇄ Alice (used by P04). */
export const DM_JENNA_ALICE = { id: 'D0000001', members: ['jenna', 'alice'] as const };

export interface Customer {
  readonly name: string;
  readonly city: string;
  readonly country: string;
  readonly tier: 'Enterprise' | 'Growth' | 'Starter';
  readonly robots: number;
  readonly owner: PersonKey;
}

export const CUSTOMERS: readonly Customer[] = [
  { name: 'Foxtrot Logistics', city: 'Columbus', country: 'US', tier: 'Enterprise', robots: 120, owner: 'sofia' },
  { name: 'Globex Distribution', city: 'Dallas', country: 'US', tier: 'Enterprise', robots: 210, owner: 'raj' },
  { name: 'Vantage Systems', city: 'Denver', country: 'US', tier: 'Enterprise', robots: 40, owner: 'hannah' },
  { name: 'Meridian Freight', city: 'Rotterdam', country: 'NL', tier: 'Enterprise', robots: 65, owner: 'diego' },
  { name: 'Cascade Fulfillment', city: 'Portland', country: 'US', tier: 'Growth', robots: 32, owner: 'raj' },
  { name: 'Halvorsen Retail', city: 'Oslo', country: 'NO', tier: 'Growth', robots: 18, owner: 'diego' },
  { name: 'Bluefin Grocers', city: 'Boston', country: 'US', tier: 'Growth', robots: 24, owner: 'hannah' },
  { name: 'Orion Parcel', city: 'Memphis', country: 'US', tier: 'Enterprise', robots: 150, owner: 'raj' },
  { name: 'Sunridge Pharma', city: 'Basel', country: 'CH', tier: 'Growth', robots: 12, owner: 'diego' },
  { name: 'Kestrel Automotive', city: 'Detroit', country: 'US', tier: 'Enterprise', robots: 88, owner: 'hannah' },
  { name: 'Northgate Wholesale', city: 'Leeds', country: 'UK', tier: 'Growth', robots: 27, owner: 'diego' },
  { name: 'Pinewood Apparel', city: 'Atlanta', country: 'US', tier: 'Starter', robots: 6, owner: 'zoe' },
  { name: 'Atlas Cold Chain', city: 'Chicago', country: 'US', tier: 'Growth', robots: 30, owner: 'raj' },
  { name: 'Lumen Electronics', city: 'Austin', country: 'US', tier: 'Starter', robots: 8, owner: 'zoe' },
  { name: 'Harbor & Quay', city: 'Hamburg', country: 'DE', tier: 'Growth', robots: 22, owner: 'diego' },
  { name: 'Tessellate Foods', city: 'Lyon', country: 'FR', tier: 'Starter', robots: 5, owner: 'zoe' },
  { name: 'Redwood Outdoor', city: 'Sacramento', country: 'US', tier: 'Starter', robots: 9, owner: 'zoe' },
  { name: 'Silverline Books', city: 'Nashville', country: 'US', tier: 'Starter', robots: 4, owner: 'hannah' },
  { name: 'Marigold Beauty', city: 'Miami', country: 'US', tier: 'Growth', robots: 16, owner: 'hannah' },
  { name: 'Ironbridge Tools', city: 'Birmingham', country: 'UK', tier: 'Growth', robots: 20, owner: 'diego' },
];

export function customer(name: string): Customer {
  const c = CUSTOMERS.find((x) => x.name === name);
  if (!c) throw new Error(`unknown customer ${name}`);
  return c;
}

/** Midnight UTC `n` days before NOW, plus the given time of day. */
export function daysAgo(n: number, hour = 10, minute = 0): Date {
  const d = new Date(NOW);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  d.setUTCHours(hour, minute, 0, 0);
  return d;
}

export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export const COMMIT_COUNT = 150;

/** Commit ordinals 1..150 are spread evenly over the span: 540 → 4 days ago. */
export function commitDaysAgo(ordinal: number): number {
  return 540 - Math.floor((ordinal - 1) * 3.6);
}

export const RESTRICTED_FINANCE: readonly PersonKey[] = ['tom', 'alice', 'elif'];
export const RESTRICTED_EXEC: readonly PersonKey[] = ['alice', 'tom', 'sofia', 'jenna'];
