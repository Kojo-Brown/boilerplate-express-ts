import { randomBytes } from 'node:crypto';
import {
  MAX_SECRET_BYTES,
  MIN_SECRET_BYTES,
  parseWebhookSigningSecrets,
  WebhookSigningSecretError,
} from '@/webhooks/signing-secrets';

const SECRET_A = randomBytes(MIN_SECRET_BYTES).toString('base64');
const SECRET_B = randomBytes(MAX_SECRET_BYTES).toString('base64');

describe('parseWebhookSigningSecrets', () => {
  it('parses a single entry and makes it active', () => {
    const ring = parseWebhookSigningSecrets(`k1:${SECRET_A}`, 'k1');

    expect(ring.activeKeyId).toBe('k1');
    expect(ring.active().id).toBe('k1');
    expect(ring.active().secret).toHaveLength(MIN_SECRET_BYTES);
    expect(ring.ids()).toEqual(['k1']);
  });

  it('verifies under every held secret while signing under one', () => {
    // The state a rotation spends most of its life in, and the whole reason this
    // is a ring: deliveries signed under `k1` by a counterparty that has not
    // redeployed yet must keep verifying after the active id has moved to `k2`.
    const ring = parseWebhookSigningSecrets(`k1:${SECRET_A},k2:${SECRET_B}`, 'k2');

    expect(ring.activeKeyId).toBe('k2');
    expect(ring.find('k1')?.secret.toString('base64')).toBe(SECRET_A);
    expect(ring.find('k2')?.secret.toString('base64')).toBe(SECRET_B);
    expect(ring.ids()).toEqual(['k1', 'k2']);
  });

  it('tolerates whitespace around entries', () => {
    // Secrets are pasted into deployment configuration by hand often enough that
    // a leading space should not be an outage.
    const ring = parseWebhookSigningSecrets(` k1:${SECRET_A} , k2:${SECRET_B} `, 'k1');
    expect(ring.ids()).toEqual(['k1', 'k2']);
  });

  it('returns undefined for a key id it does not hold', () => {
    // The verifier's live path for "a counterparty is signing under a secret this
    // deployment has not been given", which has to be an answer rather than a
    // throw — the middleware turns it into a 401 identical to a digest mismatch.
    expect(parseWebhookSigningSecrets(`k1:${SECRET_A}`, 'k1').find('k9')).toBeUndefined();
  });

  it('exposes ids as a frozen list so a caller cannot edit the ring', () => {
    const ids = parseWebhookSigningSecrets(`k1:${SECRET_A}`, 'k1').ids();
    expect(() => (ids as string[]).push('k2')).toThrow(TypeError);
  });

  it('rejects an active id the ring does not hold', () => {
    // The mistake that breaks phase two of a rotation: the active id is advanced
    // before the secret itself has been deployed. At boot this is a service that
    // does not start; missed, it is every outbound delivery signed under nothing.
    expect(() => parseWebhookSigningSecrets(`k1:${SECRET_A}`, 'k2')).toThrow(
      WebhookSigningSecretError,
    );
    expect(() => parseWebhookSigningSecrets(`k1:${SECRET_A}`, 'k2')).toThrow(/does not hold/);
  });

  it('rejects a duplicate key id even when the bytes agree', () => {
    // "Last one wins" over a secret makes verification depend on list order,
    // which is not a thing anyone thinks to look at.
    expect(() => parseWebhookSigningSecrets(`k1:${SECRET_A},k1:${SECRET_A}`, 'k1')).toThrow(
      /more than once/,
    );
  });

  it('rejects an entry with no separator', () => {
    expect(() => parseWebhookSigningSecrets(SECRET_A, 'k1')).toThrow(
      /not in "<key-id>:<base64-secret>" form/,
    );
  });

  it('rejects an empty key id', () => {
    expect(() => parseWebhookSigningSecrets(`:${SECRET_A}`, '')).toThrow(
      /not in "<key-id>:<base64-secret>" form/,
    );
  });

  it('rejects a key id outside the header parameter charset', () => {
    // The id travels in the clear in the signature header, whose fields are
    // comma- and equals-delimited, so `=` in an id would split one field into
    // two. A `,` cannot get this far to be rejected — the spec itself is comma
    // separated, so `k,1:<secret>` is two entries, the first of which has no
    // separator. Both readings end in a refused boot, which is the point.
    expect(() => parseWebhookSigningSecrets(`k=1:${SECRET_A}`, 'k=1')).toThrow(
      /which is not 1-32 characters/,
    );
    expect(() => parseWebhookSigningSecrets(`${'k'.repeat(33)}:${SECRET_A}`, 'k')).toThrow(
      /which is not 1-32 characters/,
    );
    expect(() => parseWebhookSigningSecrets(`k,1:${SECRET_A}`, 'k,1')).toThrow(
      /not in "<key-id>:<base64-secret>" form/,
    );
  });

  it('rejects material that is not base64 rather than reporting its length', () => {
    // `Buffer.from(x, 'base64')` decodes what it can and stops, so without the
    // re-encode check this arrives as a complaint about byte count — which sends
    // whoever pasted it looking for a longer secret instead of a valid one.
    expect(() => parseWebhookSigningSecrets('k1:not base64 at all!!', 'k1')).toThrow(
      /is not valid base64/,
    );
  });

  it('rejects a secret shorter than the digest it produces', () => {
    const short = randomBytes(MIN_SECRET_BYTES - 1).toString('base64');
    expect(() => parseWebhookSigningSecrets(`k1:${short}`, 'k1')).toThrow(
      new RegExp(`${MIN_SECRET_BYTES - 1} bytes`),
    );
  });

  it("rejects a secret longer than HMAC's block size", () => {
    // Past 64 bytes HMAC-SHA256 hashes the key down to 32, so the extra material
    // is discarded — and two distinct over-long secrets can collide into one
    // effective key. Refusing beats silently meaning less than it says.
    const long = randomBytes(MAX_SECRET_BYTES + 1).toString('base64');
    expect(() => parseWebhookSigningSecrets(`k1:${long}`, 'k1')).toThrow(
      new RegExp(`${MAX_SECRET_BYTES + 1} bytes`),
    );
  });

  it('rejects a spec with no entries', () => {
    expect(() => parseWebhookSigningSecrets('   ', 'k1')).toThrow(/holds no entries/);
    expect(() => parseWebhookSigningSecrets(',,', 'k1')).toThrow(/holds no entries/);
  });

  it('never puts secret material into an error message', () => {
    // The property that matters more than any individual message: a config error
    // goes to stdout and onward to the log shipper, and it is raised at exactly
    // the moment somebody is pasting secrets around.
    const short = randomBytes(8).toString('base64');
    const attempts: (() => unknown)[] = [
      () => parseWebhookSigningSecrets(`k1:${short}`, 'k1'),
      () => parseWebhookSigningSecrets(`k1:${SECRET_A},k1:${SECRET_A}`, 'k1'),
      () => parseWebhookSigningSecrets(`k1:${SECRET_A}`, 'k2'),
    ];

    for (const attempt of attempts) {
      try {
        attempt();
        throw new Error('expected the parse to fail');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).not.toContain(SECRET_A);
        expect(message).not.toContain(short);
      }
    }
  });
});
