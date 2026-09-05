// The Northwind monorepo: three dependency-free TypeScript services plus an
// SDK package, with 150 commits of synthetic history built via git fast-import
// (deterministic SHAs: fixed authors, fixed timestamps). Story commits sit at
// exact ordinals so drift defects (D*) and tribal hints (T02, T05) are
// traceable to a commit; filler commits touch CHANGELOGs only.
//
// Deviation from SPEC §2 ("TS/Express"): services use node:http with a tiny
// router so the corpus compiles offline with no install step and stays
// byte-reproducible (no lockfile churn).
import { Q } from './plants';
import type { Rng } from './rng';
import { COMMIT_COUNT, ENGINEERS, commitDaysAgo, daysAgo, person, type PersonKey } from './world';

export interface CommitSpec {
  readonly ordinal: number;
  readonly subject: string;
  readonly body: string;
  readonly author: PersonKey;
  readonly at: Date;
  /** path → new content, or null to delete */
  readonly changes: Readonly<Record<string, string | null>>;
}

// ----------------------------------------------------------------- file bodies

const ROOT_PACKAGE_JSON = `{
  "name": "northwind",
  "private": true,
  "packageManager": "pnpm@10.0.0",
  "scripts": {
    "build": "pnpm -r run build",
    "typecheck": "tsc -p tsconfig.json"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.9.0"
  }
}
`;

const PNPM_WORKSPACE = `packages:
  - services/*
  - packages/*
`;

const TSCONFIG_BASE = `{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "types": ["node"],
    "strict": true,
    "verbatimModuleSyntax": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  }
}
`;

const TSCONFIG_ROOT = `{
  "extends": "./tsconfig.base.json",
  "compilerOptions": { "noEmit": true },
  "include": ["services/*/src/**/*.ts", "packages/*/src/**/*.ts"]
}
`;

const svcTsconfig = `{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
`;

const svcPackage = (name: string, version: string): string => `{
  "name": "@northwind/${name}",
  "version": "${version}",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json"
  }
}
`;

const CODEOWNERS = `# Code owners — one approval required from an owner
* @jenna-ortiz
services/control-plane/ @jenna-ortiz
${Q.T02_CODEOWNERS}
services/billing-service/ @marcus-webb
packages/sdk/ @jenna-ortiz
infra/ @jenna-ortiz
db/ @marcus-webb
`;

const README = `# Northwind Robotics monorepo

- \`services/control-plane\` — fleet API and orchestration
- \`services/fleet-agent\` — on-site daemon brokering robots and the control plane
- \`services/billing-service\` — invoices, subscriptions, dunning
- \`packages/sdk\` — TypeScript client for the control plane API

See \`docs/api.md\` for the public API and \`CONTRIBUTING.md\` in each service.
`;

const DEPLOY_WORKFLOW = `name: deploy
on:
  push:
    tags: ['*']
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: ./infra/deploy.sh
`;

const DOCS_API = `# Control Plane API

## Limits

${Q.C10_B}

## Pagination

${Q.D08_DOC} Pass \`page_size\` to change it.

## Webhooks

${Q.D02_DOC} The signature is an HMAC-SHA256 of the raw body.

## Errors

Errors return a JSON body with a \`code\` and a \`message\`.
`;

const CONTRIBUTING_CP = `# Contributing to control-plane

## Versioning

${Q.C22_B}

## Deploys

${Q.X10_B}

## Reviews

One approval from a CODEOWNER. Squash-merge with the PR title as the subject.
`;

const FLEET_README = `# fleet-agent

The on-site daemon. Brokers between robots on the warehouse VLAN and the control plane.

## Firmware

${Q.C19_B} Sites pick the stable or canary channel.

## Running locally

\`pnpm build && node dist/agent.js\`
`;

// control-plane -----------------------------------------------------------

const ROUTER = `import type { IncomingMessage, ServerResponse } from 'node:http';

export type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => void | Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

export class Router {
  private readonly routes: Route[] = [];

  get(path: string, handler: Handler): void {
    this.add('GET', path, handler);
  }

  post(path: string, handler: Handler): void {
    this.add('POST', path, handler);
  }

  private add(method: string, path: string, handler: Handler): void {
    const keys: string[] = [];
    const source = path.replace(/:([a-zA-Z]+)/g, (_m, key: string) => {
      keys.push(key);
      return '([^/]+)';
    });
    this.routes.push({ method, pattern: new RegExp(\`^\${source}$\`), keys, handler });
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    for (const route of this.routes) {
      if (route.method !== req.method) continue;
      const match = route.pattern.exec(url.pathname);
      if (!match) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((key, i) => {
        params[key] = match[i + 1] ?? '';
      });
      await route.handler(req, res, params);
      return true;
    }
    return false;
  }
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}
`;

const AUTH_V1 = `import type { IncomingMessage } from 'node:http';

export const AUTH_SCHEME = 'api_key' as const;
export const API_KEY_HEADER = 'x-api-key';

export function verifyApiKey(req: IncomingMessage, validKeys: ReadonlySet<string>): boolean {
  const key = req.headers[API_KEY_HEADER];
  return typeof key === 'string' && validKeys.has(key);
}
`;

const AUTH_OAUTH_CORE = `import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export interface AccessToken {
  readonly clientId: string;
  readonly scope: readonly string[];
  readonly expiresAt: number;
}

const TOKEN_TTL_SECONDS = 3600;

function sign(payload: string, signingKey: string): string {
  return createHmac('sha256', signingKey).update(payload).digest('base64url');
}

/** OAuth2 client-credentials grant: exchange client id + secret for a bearer token. */
export function issueToken(
  clientId: string,
  clientSecret: string,
  clients: ReadonlyMap<string, { secret: string; scope: readonly string[] }>,
  signingKey: string,
  now = Date.now(),
): string | null {
  const client = clients.get(clientId);
  if (!client || client.secret !== clientSecret) return null;
  const payload = Buffer.from(
    JSON.stringify({ clientId, scope: client.scope, expiresAt: Math.floor(now / 1000) + TOKEN_TTL_SECONDS }),
  ).toString('base64url');
  return \`\${payload}.\${sign(payload, signingKey)}\`;
}

export function verifyBearer(req: IncomingMessage, signingKey: string, now = Date.now()): AccessToken | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const [payload, signature] = header.slice('Bearer '.length).split('.');
  if (!payload || !signature) return null;
  const expected = sign(payload, signingKey);
  if (expected.length !== signature.length) return null;
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return null;
  const token = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as AccessToken;
  return token.expiresAt * 1000 > now ? token : null;
}
`;

const AUTH_V2 = `${AUTH_OAUTH_CORE}
// Legacy API-key auth, kept during the migration window.
export const API_KEY_HEADER = 'x-api-key';

export function verifyApiKey(req: IncomingMessage, validKeys: ReadonlySet<string>): boolean {
  const key = req.headers[API_KEY_HEADER];
  return typeof key === 'string' && validKeys.has(key);
}
`;

const AUTH_V3 = `${AUTH_OAUTH_CORE}
${Q.D01_CODE}
`;

const rateLimit = (limit: number): string => `export const RATE_LIMIT_PER_MINUTE = ${limit};

const WINDOW_MS = 60_000;

interface Bucket {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, Bucket>();

export function allow(clientId: string, now = Date.now()): boolean {
  const bucket = buckets.get(clientId);
  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    buckets.set(clientId, { count: 1, windowStart: now });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= RATE_LIMIT_PER_MINUTE;
}
`;

const WEBHOOKS_V1 = `import { createHmac } from 'node:crypto';

export const SIGNATURE_HEADER = 'X-NW-Signature';
export const DELIVERY_TIMEOUT_MS = 30_000;

export type Deliverer = (
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
) => Promise<number>;

export function sign(secret: string, body: string): string {
  return \`sha256=\${createHmac('sha256', secret).update(body).digest('hex')}\`;
}

export async function deliver(url: string, body: string, secret: string, send: Deliverer): Promise<boolean> {
  const status = await send(url, body, { [SIGNATURE_HEADER]: sign(secret, body) }, DELIVERY_TIMEOUT_MS);
  return status >= 200 && status < 300;
}
`;

const WEBHOOKS_V2 = `import { createHmac } from 'node:crypto';

${Q.D02_CODE}
${Q.D10_CODE}
${Q.D10_CODE2}

export type Deliverer = (
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
) => Promise<number>;

export function sign(secret: string, body: string): string {
  return \`sha256=\${createHmac('sha256', secret).update(body).digest('hex')}\`;
}

export async function deliver(url: string, body: string, secret: string, send: Deliverer): Promise<boolean> {
  const headers = { [SIGNATURE_HEADER]: sign(secret, body) };
  for (let attempt = 0; attempt <= DELIVERY_RETRIES; attempt++) {
    const status = await send(url, body, headers, DELIVERY_TIMEOUT_MS);
    if (status >= 200 && status < 300) return true;
  }
  return false;
}
`;

const pagination = (def: number, max: number): string => `export const DEFAULT_PAGE_SIZE = ${def};
export const MAX_PAGE_SIZE = ${max};

export interface Page {
  readonly page: number;
  readonly pageSize: number;
}

export function parsePage(query: URLSearchParams): Page {
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const requested = Number(query.get('page_size') ?? String(DEFAULT_PAGE_SIZE)) || DEFAULT_PAGE_SIZE;
  return { page, pageSize: Math.min(MAX_PAGE_SIZE, Math.max(1, requested)) };
}
`;

const ERRORS_V1 = `export enum ErrorCode {
  NW_400 = 'NW-400',
  NW_401 = 'NW-401',
  NW_404 = 'NW-404',
  NW_409 = 'NW-409',
  NW_410 = 'NW-410',
  NW_422 = 'NW-422',
  NW_423 = 'NW-423',
  NW_429 = 'NW-429',
}

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
`;

const ERRORS_V2 = `export enum ErrorCode {
  E_VALIDATION = 'E_VALIDATION',
  E_UNAUTHORIZED = 'E_UNAUTHORIZED',
  ${Q.D09_CODE}
  E_RATE_LIMITED = 'E_RATE_LIMITED',
  // Not yet migrated from the NW-4xx scheme; tracked in the errors epic.
  NW_409 = 'NW-409',
  NW_410 = 'NW-410',
  NW_422 = 'NW-422',
  NW_423 = 'NW-423',
}

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
`;

const config = (dbVar: string, region: string): string => `function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(\`missing required env var \${name}\`);
  return value;
}

function env(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const config = {
  port: Number(env('PORT', '3000')),
  databaseUrl: required('${dbVar}'),
  region: env('NW_REGION', '${region}'),
  logLevel: env('LOG_LEVEL', 'info'),
} as const;
`;

const ROUTES_ROBOTS_V1 = `import { json, type Router } from '../router';

interface RobotStatus {
  id: string;
  site: string;
  state: 'active' | 'idle' | 'maintenance';
}

const fleet: RobotStatus[] = [];

export function registerRobotRoutes(router: Router): void {
  router.get('/v1/robots/status', (_req, res) => {
    json(res, 200, { robots: fleet });
  });
}
`;

const ROUTES_FLEET = `import { json, type Handler, type Router } from '../router';

export interface Robot {
  id: string;
  site: string;
  state: 'active' | 'idle' | 'maintenance' | 'demo';
  firmware: string;
}

const fleet: Robot[] = [];

export const fleetHealth: Handler = (_req, res) => {
  const active = fleet.filter((r) => r.state === 'active').length;
  json(res, 200, { total: fleet.length, active, offline: 0 });
};

export const listFleet: Handler = (_req, res) => {
  json(res, 200, { robots: fleet });
};

export function registerFleetRoutes(router: Router): void {
  ${Q.D05_CODE}
  router.get('/v2/fleet', listFleet);
}
`;

const SERVER_V1 = `import { createServer } from 'node:http';
import { Router, json } from './router';

const router = new Router();
router.get('/health', (_req, res) => json(res, 200, { ok: true }));

export function start(port: number): void {
  createServer((req, res) => {
    void router.handle(req, res).then((handled) => {
      if (!handled) json(res, 404, { error: 'not found' });
    });
  }).listen(port);
}
`;

const SERVER_V2 = `import { createServer } from 'node:http';
import { verifyApiKey } from './auth';
import { config } from './config';
import { allow } from './rateLimit';
import { Router, json } from './router';
import { registerRobotRoutes } from './routes/robots';

const router = new Router();
const apiKeys = new Set<string>();

router.get('/health', (_req, res) => json(res, 200, { ok: true }));
registerRobotRoutes(router);

export function start(port = config.port): void {
  createServer((req, res) => {
    if (!verifyApiKey(req, apiKeys)) return json(res, 401, { error: 'unauthorized' });
    if (!allow(String(req.headers['x-api-key']))) return json(res, 429, { error: 'rate limited' });
    void router.handle(req, res).then((handled) => {
      if (!handled) json(res, 404, { error: 'not found' });
    });
  }).listen(port);
}
`;

const SERVER_V3 = `import { createServer } from 'node:http';
import { verifyBearer } from './auth';
import { config } from './config';
import { ApiError, ErrorCode } from './errors';
import { allow } from './rateLimit';
import { Router, json } from './router';
import { registerFleetRoutes } from './routes/fleet';

const router = new Router();
const signingKey = process.env.TOKEN_SIGNING_KEY ?? 'dev-only';

router.get('/health', (_req, res) => json(res, 200, { ok: true }));
registerFleetRoutes(router);

export function start(port = config.port): void {
  createServer((req, res) => {
    const token = verifyBearer(req, signingKey);
    if (!token) {
      const err = new ApiError(ErrorCode.E_UNAUTHORIZED, 401, 'unauthorized');
      return json(res, err.status, { code: err.code, message: err.message });
    }
    if (!allow(token.clientId)) {
      const err = new ApiError(ErrorCode.E_RATE_LIMITED, 429, 'rate limited');
      return json(res, err.status, { code: err.code, message: err.message });
    }
    void router.handle(req, res).then((handled) => {
      if (!handled) json(res, 404, { code: ErrorCode.E_NOT_FOUND, message: 'not found' });
    });
  }).listen(port);
}
`;

// fleet-agent ---------------------------------------------------------------

const agent = (port: number): string => `import { createServer } from 'node:http';
import { planBatchPick, type PickRequest } from './pick';
import { collectTelemetry } from './telemetry';

export const DEFAULT_PORT = ${port};

export function start(port = DEFAULT_PORT): void {
  createServer((req, res) => {
    if (req.url === '/telemetry') {
      res.end(JSON.stringify(collectTelemetry()));
      return;
    }
    if (req.url === '/plan') {
      const plan = planBatchPick([] as PickRequest[]);
      res.end(JSON.stringify(plan));
      return;
    }
    res.statusCode = 404;
    res.end();
  }).listen(port);
}
`;

const pick = (threshold: number, flag: boolean): string => `export interface PickRequest {
  readonly orderId: string;
  readonly aisle: number;
  readonly bin: string;
  readonly confidence: number;
}

export interface PickPlan {
  readonly aisle: number;
  readonly picks: readonly PickRequest[];
}

export const PICK_CONFIDENCE_THRESHOLD = ${threshold};
${flag ? "\nexport const flags = { BATCH_PICK_BETA: process.env.BATCH_PICK_BETA === '1' };\n" : ''}
export function isConfident(pick: PickRequest): boolean {
  return pick.confidence >= PICK_CONFIDENCE_THRESHOLD;
}

${Q.D11_CODE}requests: readonly PickRequest[]): PickPlan[] {${
  flag ? "\n  if (!flags.BATCH_PICK_BETA) throw new Error('batch-pick is behind the BATCH_PICK_BETA flag');" : ''
}
  const byAisle = new Map<number, PickRequest[]>();
  for (const pick of requests) {
    if (!isConfident(pick)) continue;
    const list = byAisle.get(pick.aisle) ?? [];
    list.push(pick);
    byAisle.set(pick.aisle, list);
  }
  return [...byAisle.entries()].map(([aisle, picks]) => ({ aisle, picks }));
}
`;

const FIRMWARE = `export const FIRMWARE_CHANNELS = ['stable', 'canary'] as const;
export type FirmwareChannel = (typeof FIRMWARE_CHANNELS)[number];

export interface FirmwareRelease {
  readonly version: string;
  readonly channel: FirmwareChannel;
  readonly stagedPercent: number;
}

export function nextStage(release: FirmwareRelease): FirmwareRelease {
  return { ...release, stagedPercent: Math.min(100, release.stagedPercent + 10) };
}
`;

const TELEMETRY = `export interface Telemetry {
  readonly robots: number;
  readonly picksLastHour: number;
  readonly uptimeSeconds: number;
}

export function collectTelemetry(): Telemetry {
  return { robots: 0, picksLastHour: 0, uptimeSeconds: Math.floor(process.uptime()) };
}
`;

// billing-service -----------------------------------------------------------

const BILLING_CONFIG_V1 = `export const MAX_RETRIES = 3;
export const RETRY_DELAY_MS = 5_000;
`;

const BILLING_CONFIG_V2 = `${Q.D04_CODE}
export const BASE_RETRY_DELAY_MS = 2_000;
`;

const RETRY = `import { BASE_RETRY_DELAY_MS, MAX_RETRIES } from './config';

export function retryDelayMs(attempt: number): number {
  return BASE_RETRY_DELAY_MS * 2 ** attempt;
}

export async function withRetries<T>(operation: () => Promise<T>, sleep: (ms: number) => Promise<void>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      await sleep(retryDelayMs(attempt));
    }
  }
  throw lastError;
}
`;

const SUBSCRIPTIONS = `${Q.D14_CODE}

export interface Subscription {
  readonly id: string;
  readonly customerId: string;
  readonly state: SubscriptionState;
  readonly renewsAt: string;
}

export function cancel(sub: Subscription, atRenewal: boolean): Subscription {
  return { ...sub, state: atRenewal ? 'resume_at_renewal' : 'cancelled' };
}

export function resume(sub: Subscription): Subscription {
  return { ...sub, state: 'active' };
}
`;

const INVOICES = `export const DEFAULT_NET_TERMS_DAYS = 30;

export interface Invoice {
  readonly id: string;
  readonly customerId: string;
  readonly amountCents: number;
  readonly currency: 'USD' | 'EUR';
  readonly issuedAt: string;
  readonly netTermsDays: number;
}

export function dueDate(invoice: Invoice): Date {
  const due = new Date(invoice.issuedAt);
  due.setUTCDate(due.getUTCDate() + invoice.netTermsDays);
  return due;
}
`;

const DUNNING = `import type { Invoice } from './invoices';
import { dueDate } from './invoices';

export interface DunningNotice {
  readonly invoiceId: string;
  readonly step: 1 | 2 | 3;
}

export function nextNotice(invoice: Invoice, now: Date, sent: readonly DunningNotice[]): DunningNotice | null {
  const overdueDays = Math.floor((now.getTime() - dueDate(invoice).getTime()) / 86_400_000);
  if (overdueDays < 0) return null;
  const step = overdueDays < 7 ? 1 : overdueDays < 21 ? 2 : 3;
  if (sent.some((n) => n.step >= step)) return null;
  return { invoiceId: invoice.id, step };
}
`;

// packages/sdk ----------------------------------------------------------------

const SDK_V1 = `export interface Robot {
  readonly id: string;
  readonly site: string;
  readonly state: string;
}

export type Transport = (url: string, headers: Record<string, string>) => Promise<unknown>;

export class RobotsApi {
  constructor(private readonly client: NorthwindClient) {}

  list(): Promise<Robot[]> {
    return this.client.get<Robot[]>('/v1/robots');
  }
}

export class NorthwindClient {
  readonly robots = new RobotsApi(this);

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly transport: Transport,
  ) {}

  async get<T>(path: string): Promise<T> {
    return (await this.transport(this.baseUrl + path, { 'x-api-key': this.apiKey })) as T;
  }
}
`;

const SDK_V2 = `export interface Robot {
  readonly id: string;
  readonly site: string;
  readonly state: string;
  readonly firmware: string;
}

export type Transport = (url: string, headers: Record<string, string>) => Promise<unknown>;

export class FleetApi {
  constructor(private readonly client: NorthwindClient) {}

  list(): Promise<Robot[]> {
    return this.client.get<Robot[]>('/v2/fleet');
  }
}

export class NorthwindClient {
  ${Q.D15_CODE}

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly transport: Transport,
  ) {}

  async get<T>(path: string): Promise<T> {
    return (await this.transport(this.baseUrl + path, { authorization: \`Bearer \${this.token}\` })) as T;
  }
}
`;

// infra / db --------------------------------------------------------------

const terraform = (defaultRegion: string): string => `terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

variable "region" {
  description = "Default region for new customer fleets"
  default     = "${defaultRegion}"
}

provider "aws" {
  region = var.region
}

${Q.X04_B}

resource "aws_db_instance" "core" {
  identifier     = "nw-core"
  engine         = "postgres"
  engine_version = "16"
  instance_class = "db.r6g.large"
}
`;

const DB_MIGRATION = `-- 0001_init.sql
${Q.D13_CODE}

\\connect nw_core

CREATE TABLE sites (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  region text NOT NULL
);

CREATE TABLE robots (
  id uuid PRIMARY KEY,
  site_id uuid NOT NULL REFERENCES sites(id),
  serial text NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'idle'
);
`;

// ----------------------------------------------------------------- history

const CP = 'services/control-plane';
const FA = 'services/fleet-agent';
const BS = 'services/billing-service';
const SDK = 'packages/sdk';

interface Story {
  readonly subject: string;
  readonly body?: string;
  readonly author: PersonKey;
  readonly changes: Record<string, string | null>;
}

const FLEET_RELEASES: Record<number, string> = {
  28: '1.1.0',
  44: '1.2.0',
  62: '1.3.0',
  79: '1.4.0',
  97: '1.5.0',
  113: '1.6.0',
  128: '1.7.0',
  142: '1.8.0',
};

function stories(): Map<number, Story> {
  const s = new Map<number, Story>();
  const put = (ordinal: number, story: Story): void => {
    if (s.has(ordinal)) throw new Error(`duplicate story commit at ${ordinal}`);
    s.set(ordinal, story);
  };

  put(1, {
    subject: 'chore: initial monorepo scaffold',
    body: 'pnpm workspaces, shared tsconfig, CODEOWNERS.',
    author: 'jenna',
    changes: {
      'package.json': ROOT_PACKAGE_JSON,
      'pnpm-workspace.yaml': PNPM_WORKSPACE,
      'tsconfig.base.json': TSCONFIG_BASE,
      'tsconfig.json': TSCONFIG_ROOT,
      '.gitignore': 'node_modules/\ndist/\n',
      'README.md': README,
      CODEOWNERS,
      '.github/workflows/deploy.yml': DEPLOY_WORKFLOW,
    },
  });
  put(2, {
    subject: 'feat(control-plane): http server skeleton',
    author: 'jenna',
    changes: {
      [`${CP}/package.json`]: svcPackage('control-plane', '2025.03.01'),
      [`${CP}/tsconfig.json`]: svcTsconfig,
      [`${CP}/CHANGELOG.md`]: '# control-plane changelog\n',
      [`${CP}/src/router.ts`]: ROUTER,
      [`${CP}/src/server.ts`]: SERVER_V1,
    },
  });
  put(3, {
    subject: 'feat(control-plane): API key auth',
    body: 'Integrations authenticate with an X-API-Key header issued from the admin console.',
    author: 'omar',
    changes: { [`${CP}/src/auth.ts`]: AUTH_V1 },
  });
  put(8, {
    subject: 'feat(control-plane): config module',
    author: 'jenna',
    changes: { [`${CP}/src/config.ts`]: config('NW_DB_URL', 'us-east-1') },
  });
  put(10, {
    subject: 'feat(control-plane): per-client rate limiting (100 req/min)',
    author: 'lena',
    changes: { [`${CP}/src/rateLimit.ts`]: rateLimit(100) },
  });
  put(12, {
    subject: 'feat(fleet-agent): daemon skeleton on port 8080',
    author: 'dev',
    changes: {
      [`${FA}/package.json`]: svcPackage('fleet-agent', '1.0.0'),
      [`${FA}/tsconfig.json`]: svcTsconfig,
      [`${FA}/CHANGELOG.md`]: '# fleet-agent changelog\n',
      [`${FA}/src/agent.ts`]: agent(8080),
      [`${FA}/src/telemetry.ts`]: TELEMETRY,
      [`${FA}/src/pick.ts`]: pick(0.8, false),
    },
  });
  put(15, {
    subject: 'feat(billing-service): skeleton with retry config',
    author: 'marcus',
    changes: {
      [`${BS}/package.json`]: svcPackage('billing-service', '2025.03.20'),
      [`${BS}/tsconfig.json`]: svcTsconfig,
      [`${BS}/CHANGELOG.md`]: '# billing-service changelog\n',
      [`${BS}/src/config.ts`]: BILLING_CONFIG_V1,
      [`${BS}/src/invoices.ts`]: INVOICES,
    },
  });
  put(20, {
    subject: 'docs: add docs/api.md',
    body: 'Public API reference for integrators.',
    author: 'omar',
    changes: { 'docs/api.md': DOCS_API },
  });
  put(22, {
    subject: 'docs(control-plane): CONTRIBUTING with calver and deploy rules',
    author: 'jenna',
    changes: { [`${CP}/CONTRIBUTING.md`]: CONTRIBUTING_CP },
  });
  put(25, {
    subject: 'feat(control-plane): signed webhooks',
    body: 'HMAC-SHA256 over the raw body in the X-NW-Signature header. 30s delivery timeout.',
    author: 'omar',
    changes: { [`${CP}/src/webhooks.ts`]: WEBHOOKS_V1 },
  });
  put(30, {
    subject: 'feat(control-plane): GET /v1/robots/status',
    author: 'yuki',
    changes: {
      [`${CP}/src/routes/robots.ts`]: ROUTES_ROBOTS_V1,
      [`${CP}/src/server.ts`]: SERVER_V2,
    },
  });
  put(33, {
    subject: 'feat(control-plane): pagination helpers (default 50)',
    author: 'lena',
    changes: { [`${CP}/src/pagination.ts`]: pagination(50, 200) },
  });
  put(35, {
    subject: 'feat(sdk): TypeScript client with client.robots.list()',
    author: 'sam',
    changes: {
      [`${SDK}/package.json`]: svcPackage('sdk', '0.1.0'),
      [`${SDK}/tsconfig.json`]: svcTsconfig,
      [`${SDK}/CHANGELOG.md`]: '# sdk changelog\n',
      [`${SDK}/src/client.ts`]: SDK_V1,
    },
  });
  put(40, {
    subject: 'feat(control-plane): NW-4xx error codes',
    author: 'yuki',
    changes: { [`${CP}/src/errors.ts`]: ERRORS_V1 },
  });
  put(45, {
    subject: 'feat(fleet-agent): batch-pick behind BATCH_PICK_BETA flag',
    body: 'Groups confident picks by aisle. Off by default; Product enables per customer.',
    author: 'dev',
    changes: { [`${FA}/src/pick.ts`]: pick(0.8, true) },
  });
  put(48, {
    subject: 'docs(fleet-agent): README with firmware cadence',
    author: 'nina',
    changes: { [`${FA}/README.md`]: FLEET_README, [`${FA}/src/firmware.ts`]: FIRMWARE },
  });
  put(55, {
    subject: 'infra: terraform for core database, us-east-1',
    author: 'carlos',
    changes: { 'infra/terraform/main.tf': terraform('us-east-1'), 'infra/deploy.sh': '#!/bin/sh\nset -e\necho "deploying $(git describe --tags)"\n' },
  });
  put(58, {
    subject: 'perf(control-plane): raise rate limit to 120 req/min',
    body: 'Load tests show headroom; integrators were hitting 100 during nightly syncs.',
    author: 'lena',
    changes: { [`${CP}/src/rateLimit.ts`]: rateLimit(120) },
  });
  put(60, {
    subject: 'db: initial migration creating nw_core',
    author: 'marcus',
    changes: { 'db/migrations/0001_init.sql': DB_MIGRATION },
  });
  put(65, {
    subject: 'feat(billing-service): subscription states active/cancelled/resume_at_renewal',
    body: 'No pause state: customers cancel and resume at renewal instead.',
    author: 'marcus',
    changes: { [`${BS}/src/subscriptions.ts`]: SUBSCRIPTIONS, [`${BS}/src/dunning.ts`]: DUNNING },
  });
  put(71, {
    subject: 'fleet-agent: move default port to 9090',
    body: '8080 collides with the local dashboards most sites already run.',
    author: 'dev',
    changes: { [`${FA}/src/agent.ts`]: agent(9090) },
  });
  put(77, {
    subject: 'control-plane: pagination default 25, max 100',
    body: 'Large default pages were timing out for Enterprise fleets.',
    author: 'lena',
    changes: { [`${CP}/src/pagination.ts`]: pagination(25, 100) },
  });
  put(83, {
    subject: 'billing: bump MAX_RETRIES to 5 with exponential backoff',
    author: 'marcus',
    changes: { [`${BS}/src/config.ts`]: BILLING_CONFIG_V2, [`${BS}/src/retry.ts`]: RETRY },
  });
  put(88, {
    subject: 'webhooks: rename signature header to X-Northwind-Sig-256; 10s timeout, 2 retries',
    author: 'omar',
    changes: { [`${CP}/src/webhooks.ts`]: WEBHOOKS_V2 },
  });
  put(90, {
    subject: 'feat(control-plane): OAuth2 client-credentials token endpoint',
    body: 'Runs alongside API-key auth during the migration window.',
    author: 'omar',
    changes: { [`${CP}/src/auth.ts`]: AUTH_V2 },
  });
  put(93, {
    subject: Q.T05_COMMIT,
    body: Q.T05_COMMIT,
    author: 'dev',
    changes: { [`${FA}/src/pick.ts`]: pick(0.87, true) },
  });
  put(96, {
    subject: Q.D01_COMMIT,
    body: 'All integrations have migrated to OAuth2 client credentials.',
    author: 'omar',
    changes: { [`${CP}/src/auth.ts`]: AUTH_V3 },
  });
  put(102, {
    subject: `feat(control-plane): ${Q.D05_COMMIT}`,
    body: 'The v1 endpoint is deleted, not deprecated: it never had consumers outside the SDK.',
    author: 'yuki',
    changes: {
      [`${CP}/src/routes/robots.ts`]: null,
      [`${CP}/src/routes/fleet.ts`]: ROUTES_FLEET,
      [`${CP}/src/server.ts`]: SERVER_V3,
    },
  });
  put(105, {
    subject: `infra: ${Q.D07_COMMIT}`,
    body: 'New customer fleets default to eu-west-1; us-east-1 stays for existing sites.',
    author: 'carlos',
    changes: { 'infra/terraform/main.tf': terraform('eu-west-1'), [`${CP}/src/config.ts`]: config('NW_DB_URL', 'eu-west-1') },
  });
  put(110, {
    subject: `config: ${Q.D06_COMMIT}`,
    author: 'jenna',
    changes: { [`${CP}/src/config.ts`]: config('DATABASE_URL', 'eu-west-1') },
  });
  put(115, {
    subject: `errors: ${Q.D09_COMMIT}`,
    body: 'Second half tracked in the errors epic.',
    author: 'yuki',
    changes: { [`${CP}/src/errors.ts`]: ERRORS_V2 },
  });
  put(120, {
    subject: `fleet-agent: ${Q.D11_COMMIT}`,
    author: 'dev',
    changes: { [`${FA}/src/pick.ts`]: pick(0.87, false) },
  });
  put(134, {
    subject: `sdk: ${Q.D15_COMMIT}`,
    body: 'Matches the v2 fleet API. Bearer tokens replace the api key.',
    author: 'sam',
    changes: { [`${SDK}/src/client.ts`]: SDK_V2 },
  });

  for (const [ordinal, version] of Object.entries(FLEET_RELEASES)) {
    put(Number(ordinal), {
      subject: `${Q.T02_RELEASE_PREFIX}${version}`,
      body: `Release notes in CHANGELOG. Staged to canary sites first.`,
      author: 'dev',
      changes: { [`${FA}/package.json`]: svcPackage('fleet-agent', version) },
    });
  }
  return s;
}

const FILLER_KINDS: ReadonlyArray<[string, string[]]> = [
  ['chore', ['bump dependencies', 'tidy imports', 'update lint config', 'refresh lockfile']],
  ['test', ['add coverage for pagination edge cases', 'cover webhook signing', 'add retry backoff tests', 'snapshot the health endpoint']],
  ['fix', ['typo in log message', 'off-by-one in page math', 'handle empty fleet gracefully', 'trim whitespace in serials']],
  ['refactor', ['extract helper', 'simplify router matching', 'rename internal types', 'split config loader']],
  ['docs', ['clarify README', 'add changelog entry', 'document env vars', 'fix broken link']],
];

export function buildCommits(parent: Rng): CommitSpec[] {
  const rng = parent.fork('repo');
  const story = stories();
  const changelogs = new Map<string, string>();
  const commits: CommitSpec[] = [];

  for (let ordinal = 1; ordinal <= COMMIT_COUNT; ordinal++) {
    const at = daysAgo(commitDaysAgo(ordinal), rng.int(9, 18), rng.int(0, 59));
    const pr = 100 + ordinal;
    const st = story.get(ordinal);
    if (st) {
      const reviewer = rng.pick(ENGINEERS.filter((e) => e !== st.author));
      commits.push({
        ordinal,
        subject: st.subject,
        body: `${st.body ?? ''}${st.body ? '\n\n' : ''}PR #${pr}\nReviewed-by: ${person(reviewer).name}`,
        author: st.author,
        at,
        changes: st.changes,
      });
      for (const path of Object.keys(st.changes)) {
        if (path.endsWith('CHANGELOG.md')) changelogs.set(path, st.changes[path] ?? '');
      }
      continue;
    }
    const svc = rng.pick(['control-plane', 'fleet-agent', 'billing-service', 'sdk']);
    const dir = svc === 'sdk' ? SDK : `services/${svc}`;
    const [kind, subjects] = rng.pick(FILLER_KINDS);
    const subject = `${kind}(${svc}): ${rng.pick(subjects)}`;
    const author = rng.pick(ENGINEERS);
    const reviewer = rng.pick(ENGINEERS.filter((e) => e !== author));
    const logPath = `${dir}/CHANGELOG.md`;
    const previous = changelogs.get(logPath) ?? `# ${svc} changelog\n`;
    const next = `${previous}- ${subject} (#${pr})\n`;
    changelogs.set(logPath, next);
    commits.push({
      ordinal,
      subject,
      body: `PR #${pr}\nReviewed-by: ${person(reviewer).name}`,
      author,
      at,
      changes: { [logPath]: next },
    });
  }
  return commits;
}

/** Final working tree after applying every commit in order. */
export function finalTree(commits: readonly CommitSpec[]): Map<string, string> {
  const tree = new Map<string, string>();
  for (const c of commits) {
    for (const [path, content] of Object.entries(c.changes)) {
      if (content === null) tree.delete(path);
      else tree.set(path, content);
    }
  }
  return tree;
}

/** git fast-import stream producing refs/heads/main with deterministic SHAs. */
export function fastImportStream(commits: readonly CommitSpec[]): Buffer {
  const chunks: Buffer[] = [];
  const push = (s: string): void => {
    chunks.push(Buffer.from(s, 'utf8'));
  };
  const data = (s: string): void => {
    const buf = Buffer.from(s, 'utf8');
    push(`data ${buf.length}\n`);
    chunks.push(buf);
    push('\n');
  };
  for (const c of commits) {
    const p = person(c.author);
    const epoch = Math.floor(c.at.getTime() / 1000);
    push('commit refs/heads/main\n');
    push(`mark :${c.ordinal}\n`);
    push(`author ${p.name} <${p.email}> ${epoch} +0000\n`);
    push(`committer ${p.name} <${p.email}> ${epoch} +0000\n`);
    data(`${c.subject}\n\n${c.body}\n`);
    for (const [path, content] of Object.entries(c.changes)) {
      if (content === null) {
        push(`D ${path}\n`);
      } else {
        push(`M 100644 inline ${path}\n`);
        data(content);
      }
    }
    push('\n');
  }
  push('done\n');
  return Buffer.concat(chunks);
}
