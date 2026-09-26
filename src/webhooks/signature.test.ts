import { createHmac, randomBytes } from 'node:crypto';
import {
  bodyDigest,
  canonicalRequest,
  computeDigest,
  digestsMatch,
  formatSignatureHeader,
  parseSignatureHeader,
  WEBHOOK_SIGNATURE_VERSION,
} from '@/webhooks/signature';
import { WebhookSignatureMalformedError } from '@/webhooks/webhooks.errors';

const NONCE = 'a'.repeat(32);
const SECRET = randomBytes(32);

function parts(overrides: Partial<Parameters<typeof canonicalRequest>[0]> = {}) {
  return {
    timestamp: 1_760_000_000,
    nonce: NONCE,
    method: 'POST',
    target: '/v1/webhooks/inbound',
    body: Buffer.from('{"id":"evt_1"}'),
    ...overrides,
  };
}

describe('bodyDigest', () => {
  it('hashes bytes, not text', () => {
    // The body may be any bytes at all. Hashing is what keeps the canonical form
    // a text protocol whose fields cannot be moved by a crafted payload.
    const binary = Buffer.from([0x00, 0x0a, 0xff, 0x0d]);
    expect(bodyDigest(binary)).toMatch(/^[0-9a-f]{64}$/);
    expect(bodyDigest(Buffer.alloc(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('canonicalRequest', () => {
  it('produces the documented six-line form', () => {
    expect(canonicalRequest(parts())).toBe(
      [
        WEBHOOK_SIGNATURE_VERSION,
        '1760000000',
        NONCE,
        'POST',
        '/v1/webhooks/inbound',
        bodyDigest(Buffer.from('{"id":"evt_1"}')),
      ].join('\n'),
    );
  });

  it('binds the signature to the version, so a v1 digest cannot be read as a v2 one', () => {
    expect(canonicalRequest(parts()).startsWith(`${WEBHOOK_SIGNATURE_VERSION}\n`)).toBe(true);
  });

  it('uppercases the method', () => {
    expect(canonicalRequest(parts({ method: 'post' }))).toBe(canonicalRequest(parts()));
  });

  it('binds the signature to the target, including the query string', () => {
    // The cross-endpoint replay this field exists to stop: two webhook routes
    // sharing one secret, and a signature that names neither would be accepted by
    // both.
    const a = canonicalRequest(parts({ target: '/v1/webhooks/inbound' }));
    const b = canonicalRequest(parts({ target: '/v1/webhooks/inbound?source=billing' }));
    expect(a).not.toBe(b);
  });

  it('cannot be made ambiguous by a body containing the field separator', () => {
    // The field-splitting attack every signing scheme has to answer. A raw body
    // spliced into the canonical string could move the boundaries; a body hashed
    // to 64 hex characters cannot.
    const sneaky = Buffer.from(`\n${NONCE}\nPOST\n/v1/webhooks/elsewhere\n`);
    const canonical = canonicalRequest(parts({ body: sneaky }));

    expect(canonical.split('\n')).toHaveLength(6);
    expect(canonical).not.toContain('/v1/webhooks/elsewhere');
  });

  it('rejects a non-integer or negative timestamp', () => {
    expect(() => canonicalRequest(parts({ timestamp: 1.5 }))).toThrow(
      WebhookSignatureMalformedError,
    );
    expect(() => canonicalRequest(parts({ timestamp: -1 }))).toThrow(
      WebhookSignatureMalformedError,
    );
  });

  it('rejects a nonce outside the permitted alphabet or length', () => {
    expect(() => canonicalRequest(parts({ nonce: 'too-short' }))).toThrow(/16-64 characters/);
    expect(() => canonicalRequest(parts({ nonce: `${NONCE},x` }))).toThrow(/16-64 characters/);
    expect(() => canonicalRequest(parts({ nonce: 'x'.repeat(65) }))).toThrow(/16-64 characters/);
  });

  it('rejects a target containing CR or LF', () => {
    // Unreachable from a verified request — Node's parser refuses the target long
    // before a handler sees it — and reachable from the signing side, where the
    // target is a string some caller built.
    expect(() => canonicalRequest(parts({ target: '/a\n/b' }))).toThrow(/CR or LF/);
    expect(() => canonicalRequest(parts({ target: '/a\r/b' }))).toThrow(/CR or LF/);
  });
});

describe('computeDigest', () => {
  it('is HMAC-SHA256 over the canonical string, as lowercase hex', () => {
    // Asserted against `crypto` directly rather than against a recorded constant:
    // the claim worth pinning is which construction this is, and a snapshot would
    // survive a change of algorithm.
    const canonical = canonicalRequest(parts());
    expect(computeDigest(SECRET, canonical)).toBe(
      createHmac('sha256', SECRET).update(canonical, 'utf8').digest('hex'),
    );
    expect(computeDigest(SECRET, canonical)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes if any covered field changes', () => {
    const baseline = computeDigest(SECRET, canonicalRequest(parts()));
    const mutations = [
      parts({ timestamp: 1_760_000_001 }),
      parts({ nonce: 'b'.repeat(32) }),
      parts({ method: 'PUT' }),
      parts({ target: '/v1/webhooks/other' }),
      parts({ body: Buffer.from('{"id":"evt_2"}') }),
    ];

    for (const mutated of mutations) {
      expect(computeDigest(SECRET, canonicalRequest(mutated))).not.toBe(baseline);
    }
  });

  it('changes with the secret', () => {
    const canonical = canonicalRequest(parts());
    expect(computeDigest(randomBytes(32), canonical)).not.toBe(computeDigest(SECRET, canonical));
  });
});

describe('formatSignatureHeader / parseSignatureHeader', () => {
  const signature = {
    timestamp: 1_760_000_000,
    nonce: NONCE,
    keyId: 'k1',
    digest: 'f'.repeat(64),
  };

  it('round-trips', () => {
    expect(parseSignatureHeader(formatSignatureHeader(signature))).toEqual(signature);
  });

  it('emits the documented field order', () => {
    expect(formatSignatureHeader(signature)).toBe(
      `t=1760000000,n=${NONCE},kid=k1,${WEBHOOK_SIGNATURE_VERSION}=${'f'.repeat(64)}`,
    );
  });

  it('accepts fields in any order and tolerates whitespace', () => {
    expect(
      parseSignatureHeader(
        ` kid=k1 , ${WEBHOOK_SIGNATURE_VERSION}=${'f'.repeat(64)} , n=${NONCE} , t=1760000000 `,
      ),
    ).toEqual(signature);
  });

  it('ignores an unknown field so a later scheme can be rolled out to senders first', () => {
    // The same two-phase argument the secret ring exists for, applied to the wire
    // format: senders may start emitting a field before receivers understand it.
    expect(
      parseSignatureHeader(`${formatSignatureHeader(signature)},v2=${'a'.repeat(128)}`),
    ).toEqual(signature);
  });

  it('rejects a repeated field rather than letting one win', () => {
    // "Last one wins" over a signature field is how a header-smuggling bug gets
    // in: the proxy, the sender's library and this parser would each be entitled
    // to a different reading of which value counted.
    expect(() => parseSignatureHeader(`${formatSignatureHeader(signature)},t=1760000999`)).toThrow(
      /appears more than once/,
    );
  });

  it('names the field that is missing', () => {
    const full = formatSignatureHeader(signature);
    const fields = full.split(',');

    for (const [index, name] of ['t', 'n', 'kid', WEBHOOK_SIGNATURE_VERSION].entries()) {
      const without = fields.filter((_field, position) => position !== index).join(',');
      expect(() => parseSignatureHeader(without)).toThrow(`field "${name}" is missing`);
    }
  });

  it('rejects a field that is not name=value', () => {
    expect(() => parseSignatureHeader('t1760000000')).toThrow(/every field must be/);
    expect(() => parseSignatureHeader('=1760000000')).toThrow(/every field must be/);
  });

  it('rejects every numeric spelling but plain digits', () => {
    // `Number` reads ' 42 ', '4e1', '0x2a' and '+42' as numbers, and
    // `canonicalRequest` would re-serialise all four as '42' — verifying a digest
    // over a string the sender never sent. One spelling per value is the only way
    // the round trip is lossless.
    for (const spelling of [' 1760000000', '1.76e9', '0x68c6b400', '+1760000000', '-1']) {
      expect(() =>
        parseSignatureHeader(`t=${spelling},n=${NONCE},kid=k1,v1=${'f'.repeat(64)}`),
      ).toThrow(/plain digits/);
    }
  });

  it('rejects a digest of the wrong length or alphabet', () => {
    expect(() =>
      parseSignatureHeader(`t=1760000000,n=${NONCE},kid=k1,v1=${'f'.repeat(63)}`),
    ).toThrow(/64 lowercase hex/);
    expect(() =>
      parseSignatureHeader(`t=1760000000,n=${NONCE},kid=k1,v1=${'F'.repeat(64)}`),
    ).toThrow(/64 lowercase hex/);
  });

  it('rejects a nonce it would not have produced', () => {
    expect(() =>
      parseSignatureHeader(`t=1760000000,n=short,kid=k1,v1=${'f'.repeat(64)}`),
    ).toThrow(/16-64 characters/);
  });

  it('does not check the key id against any ring', () => {
    // Parsing establishes only that a signature was *presented*. Everything that
    // depends on a secret happens in one place, in the middleware.
    expect(parseSignatureHeader(formatSignatureHeader({ ...signature, keyId: 'never-deployed' }))
      .keyId).toBe('never-deployed');
  });
});

describe('digestsMatch', () => {
  it('accepts an identical digest', () => {
    const digest = computeDigest(SECRET, canonicalRequest(parts()));
    expect(digestsMatch(digest, digest)).toBe(true);
  });

  it('rejects a digest differing in one character, wherever it differs', () => {
    // The two positions that separate a constant-time comparison from `===`: the
    // first character and the last. `===` returns at the first difference, which
    // is what leaks the length of a matched prefix.
    const digest = computeDigest(SECRET, canonicalRequest(parts()));
    const flip = (index: number): string => {
      const characters = [...digest];
      characters[index] = digest[index] === '0' ? '1' : '0';
      return characters.join('');
    };

    expect(digestsMatch(digest, flip(0))).toBe(false);
    expect(digestsMatch(digest, flip(63))).toBe(false);
  });

  it('rejects a length mismatch rather than throwing', () => {
    // `timingSafeEqual` throws on unequal lengths, and a verifier that throws
    // where it should answer `false` is a 500 on a request that deserves a 401.
    const digest = computeDigest(SECRET, canonicalRequest(parts()));
    expect(digestsMatch(digest, digest.slice(0, 62))).toBe(false);
    expect(digestsMatch(digest, `${digest}00`)).toBe(false);
  });

  it('rejects two empty digests', () => {
    // Not a reachable input today, and the answer a future caller should get:
    // "nothing equals nothing" is the shape of an authentication bypass.
    expect(digestsMatch('', '')).toBe(false);
  });
});
