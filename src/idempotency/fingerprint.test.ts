import type { Request } from 'express';
import { canonicalJson, requestFingerprint, scopeFor } from '@/idempotency/fingerprint';

describe('canonicalJson', () => {
  it('is insensitive to object key order', () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it('is insensitive to key order at every depth', () => {
    const left = { outer: { z: [{ b: 1, a: 2 }], a: 'x' } };
    const right = { outer: { a: 'x', z: [{ a: 2, b: 1 }] } };

    expect(canonicalJson(left)).toBe(canonicalJson(right));
  });

  it('is sensitive to array order', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('distinguishes an absent body from null', () => {
    expect(canonicalJson(undefined)).not.toBe(canonicalJson(null));
  });

  it('cannot be collided with by a body containing the absent-body token', () => {
    // The token is not valid JSON output, so no real value can produce it.
    expect(canonicalJson(' undefined')).not.toBe(canonicalJson(undefined));
    expect(canonicalJson({ ' undefined': true })).not.toBe(canonicalJson(undefined));
  });

  it('drops undefined-valued keys, matching what JSON.stringify would have sent', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it('distinguishes values that share a string form', () => {
    expect(canonicalJson(1)).not.toBe(canonicalJson('1'));
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: '1' }));
  });

  it('does not conflate a nested object with its serialised form', () => {
    expect(canonicalJson({ a: { b: 1 } })).not.toBe(canonicalJson({ a: '{"b":1}' }));
  });
});

describe('requestFingerprint', () => {
  it('is equal for equal bodies regardless of key order', () => {
    expect(requestFingerprint({ email: 'a@b.test', roles: ['user'] })).toBe(
      requestFingerprint({ roles: ['user'], email: 'a@b.test' }),
    );
  });

  it('differs when any value differs', () => {
    expect(requestFingerprint({ email: 'a@b.test' })).not.toBe(
      requestFingerprint({ email: 'c@d.test' }),
    );
  });

  it('is a hex sha-256 digest, so the body itself is never stored', () => {
    const fingerprint = requestFingerprint({ password: 'hunter2' });

    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint).not.toContain('hunter2');
  });
});

/** Only the four fields `scopeFor` reads. */
function requestLike(overrides: {
  method: string;
  originalUrl: string;
  userId?: string;
}): Request {
  const { method, originalUrl, userId } = overrides;
  return {
    method,
    originalUrl,
    ...(userId === undefined
      ? {}
      : { auth: { userId, roles: ['user'], type: 'access' } }),
  } as Request;
}

describe('scopeFor', () => {
  it('separates two principals using the same key on the same route', () => {
    const mine = scopeFor(requestLike({ method: 'POST', originalUrl: '/v1/users', userId: 'u1' }));
    const theirs = scopeFor(requestLike({ method: 'POST', originalUrl: '/v1/users', userId: 'u2' }));

    expect(mine).not.toBe(theirs);
  });

  it('separates routes, so one key reused across endpoints is not a conflict', () => {
    const users = scopeFor(requestLike({ method: 'POST', originalUrl: '/v1/users', userId: 'u1' }));
    const uploads = scopeFor(
      requestLike({ method: 'POST', originalUrl: '/v1/uploads', userId: 'u1' }),
    );

    expect(users).not.toBe(uploads);
  });

  it('separates methods on the same path', () => {
    const post = scopeFor(requestLike({ method: 'POST', originalUrl: '/v1/users', userId: 'u1' }));
    const put = scopeFor(requestLike({ method: 'PUT', originalUrl: '/v1/users', userId: 'u1' }));

    expect(post).not.toBe(put);
  });

  it('separates a query string, which names a different operation', () => {
    const plain = scopeFor(requestLike({ method: 'POST', originalUrl: '/v1/users', userId: 'u1' }));
    const dryRun = scopeFor(
      requestLike({ method: 'POST', originalUrl: '/v1/users?dry_run=true', userId: 'u1' }),
    );

    expect(plain).not.toBe(dryRun);
  });

  it('normalises the method so `post` and `POST` share a scope', () => {
    const lower = scopeFor(requestLike({ method: 'post', originalUrl: '/v1/users', userId: 'u1' }));
    const upper = scopeFor(requestLike({ method: 'POST', originalUrl: '/v1/users', userId: 'u1' }));

    expect(lower).toBe(upper);
  });

  it('puts unauthenticated callers in one shared bucket', () => {
    const scope = scopeFor(requestLike({ method: 'POST', originalUrl: '/v1/users' }));

    expect(scope).toBe('anonymous:POST:/v1/users');
  });
});
