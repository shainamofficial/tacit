import { describe, expect, it } from 'vitest';
import { redact, scanSecrets, shannonEntropy } from './secrets';

const detectorsOf = (s: string): string[] => scanSecrets(s).map((x) => x.detector);

describe('scanSecrets', () => {
  it('detects the common credential shapes', () => {
    expect(detectorsOf('aws_key = AKIAIOSFODNN7EXAMPLE')).toContain('aws_access_key');
    expect(detectorsOf('token: ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD')).toContain('github_token');
    expect(detectorsOf('slack xoxb-1234567890-abcdefghij')).toContain('slack_token');
    expect(detectorsOf('ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789')).toContain('anthropic_key');
    expect(detectorsOf('STRIPE=sk_live_abcdefghijklmnop1234')).toContain('stripe_key');
    expect(detectorsOf('-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----')).toContain('private_key');
    expect(detectorsOf('bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U')).toContain('jwt');
    expect(detectorsOf('DATABASE_URL=postgres://tacit:s3cretPassw0rd@db.internal:5432/tacit')).toContain('connection_string_password');
    expect(detectorsOf('client_secret: "Zx9qL2mN8vB4kP7wR1tY5uH3jF6gD0sA"')).toContain('assigned_secret');
  });

  it('flags a random high-entropy token in an assignment context and spans only the value', () => {
    const text = 'export const API_KEY = "q7Hs2kLp9ZxWv4Rt8NmB3cYd6FgJ1eUa5oIhK0lQ";';
    const spans = scanSecrets(text);
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0]!.start, spans[0]!.end)).toBe('q7Hs2kLp9ZxWv4Rt8NmB3cYd6FgJ1eUa5oIhK0lQ');
  });

  it('does not flag ordinary code, git shas, URLs, or identifiers', () => {
    const benign = [
      'const hash = createHmac("sha256", secret).update(body).digest("hex");',
      'commit 837e013bf454b4d9b9a1d5e2f0c3a6b7c8d9e0f1',
      'https://github.com/shainamofficial/tacit/pull/4',
      'PICK_CONFIDENCE_THRESHOLD = 0.87',
      'services/control-plane/src/routes/fleet.ts',
      'export const SIGNATURE_HEADER = "X-Northwind-Sig-256";',
      'the-quick-brown-fox-jumps-over-the-lazy-dog-many-times',
      'Refunds: 30 days on all plans, no questions asked.',
    ];
    for (const line of benign) expect(scanSecrets(line), line).toEqual([]);
  });

  it('resolves overlapping matches to a single span', () => {
    const text = 'password=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
    expect(scanSecrets(text)).toHaveLength(1);
  });

  it('redacts by reference id without touching the rest', () => {
    const text = 'before AKIAIOSFODNN7EXAMPLE middle ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD after';
    const spans = scanSecrets(text);
    const out = redact(text, spans, ['id-1', 'id-2']);
    expect(out).toBe('before [SECRET:id-1] middle [SECRET:id-2] after');
    expect(out).not.toContain('AKIA');
  });

  it('entropy helper behaves', () => {
    expect(shannonEntropy('aaaa')).toBe(0);
    expect(shannonEntropy('abcd')).toBe(2);
  });
});
