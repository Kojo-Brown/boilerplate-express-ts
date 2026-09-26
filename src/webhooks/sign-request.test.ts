import { randomBytes } from 'node:crypto';
import { signWebhookRequest } from '@/webhooks/sign-request';
import {
  canonicalRequest,
  computeDigest,
  parseSignatureHeader,
  WEBHOOK_SIGNATURE_HEADER,
} from '@/webhooks/signature';
import { parseWebhookSigningSecrets } from '@/webhooks/signing-secrets';

const SECRET_A = randomBytes(32).toString('base64');
const SECRET_B = randomBytes(32).toString('base64');
const ring = parseWebhookSigningSecrets(`k1:${SECRET_A},k2:${SECRET_B}`, 'k1');

const NONCE = 'c'.repeat(32);
const FIXED_MS = 1_760_000_000_123;

function sign(overrides: Partial<Parameters<typeof signWebhookRequest>[0]> = {}) {
  return signWebhookRequest({
    ring,
    url: '/v1/webhooks/inbound',
    body: '{"id":"evt_1"}',
    now: () => FIXED_MS,
    nonce: () => NONCE,
    ...overrides,
  });
}

describe('signWebhookRequest', () => {
  it('produces one header, byte for byte', () => {
    // Asserted exactly rather than by round-trip, because the wire format is a
    // contract with somebody else's HTTP client and "a header that parses" is a
    // weaker claim than "this header".
    const signed = sign();
    const digest = computeDigest(
      Buffer.from(SECRET_A, 'base64'),
      canonicalRequest({
        timestamp: 1_760_000_000,
        nonce: NONCE,
        method: 'POST',
        target: '/v1/webhooks/inbound',
        body: Buffer.from('{"id":"evt_1"}'),
      }),
    );

    expect(Object.keys(signed.headers)).toEqual([WEBHOOK_SIGNATURE_HEADER]);
    expect(signed.headers[WEBHOOK_SIGNATURE_HEADER]).toBe(
      `t=1760000000,n=${NONCE},kid=k1,v1=${digest}`,
    );
  });

  it('floors the clock to unix seconds', () => {
    // The unit is part of the wire format. Milliseconds would make a receiver
    // compute a skew of decades and refuse everything — which is the *good*
    // failure, and the conversion is here so nobody has to rely on getting it.
    expect(sign().signature.timestamp).toBe(1_760_000_000);
  });

  it('signs under the active entry, not the whole ring', () => {
    expect(sign().signature.keyId).toBe('k1');
    expect(
      sign({ ring: parseWebhookSigningSecrets(`k1:${SECRET_A},k2:${SECRET_B}`, 'k2') }).signature
        .keyId,
    ).toBe('k2');
  });

  it('reduces an absolute URL to path and query', () => {
    // The host is in the `Host` header and is deliberately not signed: behind a
    // load balancer, a mesh or a tunnel, the value a receiver sees is routinely
    // not the one the sender dialled.
    const fromAbsolute = sign({ url: 'https://api.example.test/v1/webhooks/inbound?source=x' });
    const fromOriginForm = sign({ url: '/v1/webhooks/inbound?source=x' });

    expect(fromAbsolute.canonical).toBe(fromOriginForm.canonical);
    expect(fromAbsolute.canonical).toContain('/v1/webhooks/inbound?source=x');
    expect(fromAbsolute.canonical).not.toContain('api.example.test');
  });

  it('defaults to POST and accepts another method', () => {
    expect(sign().canonical.split('\n')[3]).toBe('POST');
    expect(sign({ method: 'put' }).canonical.split('\n')[3]).toBe('PUT');
  });

  it('signs a string body as its UTF-8 bytes', () => {
    // `JSON.stringify` hands back a string and a delivery worker hands back a
    // Buffer; both have to reach the same digest or the scheme has two meanings.
    const body = '{"note":"café ☕"}';
    expect(sign({ body }).canonical).toBe(sign({ body: Buffer.from(body, 'utf8') }).canonical);
  });

  it('generates a fresh nonce per call in the alphabet the parser accepts', () => {
    const first = signWebhookRequest({ ring, url: '/v1/webhooks/inbound', body: '{}' });
    const second = signWebhookRequest({ ring, url: '/v1/webhooks/inbound', body: '{}' });

    expect(first.signature.nonce).not.toBe(second.signature.nonce);
    expect(first.signature.nonce).toMatch(/^[0-9a-f]{32}$/);
    // The round trip is the real assertion: a generated nonce the receiver's
    // parser would reject is a sender that can never deliver.
    expect(() => parseSignatureHeader(first.headers[WEBHOOK_SIGNATURE_HEADER] ?? '')).not.toThrow();
  });

  it('returns the canonical string it signed', () => {
    // Carried out of the function because it is what a failure report quotes: two
    // canonical strings side by side say immediately which field the two sides
    // disagree about, where two digests say only that they do.
    expect(sign().canonical.split('\n')).toHaveLength(6);
  });

  it('returns frozen headers', () => {
    expect(() => {
      (sign().headers as Record<string, string>)['x-webhook-signature'] = 'tampered';
    }).toThrow(TypeError);
  });
});
