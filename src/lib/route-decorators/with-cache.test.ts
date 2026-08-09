import type { Request } from 'express';
import type { JwtPayload } from '@/auth/auth.types';
import { MemoryCacheStore } from '@/lib/route-decorators/cache-store';
import type { OperationContext } from '@/lib/route-decorators/types';
import { defaultCacheKey, withCache } from '@/lib/route-decorators/with-cache';

function makeRequest(
  overrides: { method?: string; originalUrl?: string; auth?: JwtPayload } = {},
): Request {
  const { method = 'GET', originalUrl = '/v1/users', auth } = overrides;
  return { method, originalUrl, auth } as Request;
}

function principal(userId: string): JwtPayload {
  return { userId, roles: ['user'], type: 'access' };
}

function makeContext(): OperationContext {
  return { signal: new AbortController().signal, attempt: 1, meta: {} };
}

/** A deferred promise, so a miss can be held open while a second call arrives. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('defaultCacheKey', () => {
  it('separates two principals asking the same URL', () => {
    const alice = defaultCacheKey(makeRequest({ auth: principal('alice') }));
    const bob = defaultCacheKey(makeRequest({ auth: principal('bob') }));

    expect(alice).not.toBe(bob);
  });

  it('buckets unauthenticated callers together', () => {
    expect(defaultCacheKey(makeRequest())).toBe('anonymous:GET:/v1/users');
  });

  it('keeps the query string, which changes the answer', () => {
    expect(defaultCacheKey(makeRequest({ originalUrl: '/v1/users?limit=10' }))).not.toBe(
      defaultCacheKey(makeRequest({ originalUrl: '/v1/users?limit=20' })),
    );
  });
});

describe('withCache', () => {
  it('calls through on a miss and serves the second read from the store', async () => {
    const op = jest.fn(async () => ['a']);
    const decorated = withCache(op, { ttlMs: 1_000, namespace: 'users' });

    const first = makeContext();
    await expect(decorated(makeRequest(), first)).resolves.toEqual(['a']);
    expect(first.meta).toEqual({ cache: 'miss' });

    const second = makeContext();
    await expect(decorated(makeRequest(), second)).resolves.toEqual(['a']);
    expect(second.meta).toEqual({ cache: 'hit' });

    expect(op).toHaveBeenCalledTimes(1);
  });

  it('re-runs the operation once the entry expires', async () => {
    let now = 0;
    const store = new MemoryCacheStore({ now: () => now });
    const op = jest.fn<Promise<string>, []>().mockResolvedValueOnce('v1').mockResolvedValue('v2');
    const decorated = withCache(op, { ttlMs: 100, namespace: 'users', store });

    await expect(decorated(makeRequest(), makeContext())).resolves.toBe('v1');
    now = 101;
    await expect(decorated(makeRequest(), makeContext())).resolves.toBe('v2');

    expect(op).toHaveBeenCalledTimes(2);
  });

  it('never serves one principal the answer computed for another', async () => {
    const op = jest.fn(async (req: Request) => req.auth?.userId ?? 'anonymous');
    const decorated = withCache(op, { ttlMs: 1_000, namespace: 'users' });

    await expect(
      decorated(makeRequest({ auth: principal('alice') }), makeContext()),
    ).resolves.toBe('alice');
    await expect(decorated(makeRequest({ auth: principal('bob') }), makeContext())).resolves.toBe(
      'bob',
    );

    expect(op).toHaveBeenCalledTimes(2);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('bypasses %s entirely', async (method) => {
    const op = jest.fn(async () => 'written');
    const decorated = withCache(op, { ttlMs: 1_000, namespace: 'users' });

    const ctx = makeContext();
    await decorated(makeRequest({ method }), ctx);
    await decorated(makeRequest({ method }), makeContext());

    expect(ctx.meta).toEqual({ cache: 'bypass' });
    expect(op).toHaveBeenCalledTimes(2);
  });

  it('caches HEAD alongside GET', async () => {
    const op = jest.fn(async () => 'v');
    const decorated = withCache(op, { ttlMs: 1_000, namespace: 'users' });

    const ctx = makeContext();
    await decorated(makeRequest({ method: 'HEAD' }), ctx);

    expect(ctx.meta).toEqual({ cache: 'miss' });
  });

  it('does not cache a failure — a blip must not become a TTL-long outage', async () => {
    const op = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(new Error('upstream down'))
      .mockResolvedValue('recovered');
    const decorated = withCache(op, { ttlMs: 10_000, namespace: 'users' });

    await expect(decorated(makeRequest(), makeContext())).rejects.toThrow('upstream down');
    await expect(decorated(makeRequest(), makeContext())).resolves.toBe('recovered');
  });

  it('coalesces concurrent misses into a single call', async () => {
    const gate = deferred<string>();
    const op = jest.fn(() => gate.promise);
    const decorated = withCache(op, { ttlMs: 1_000, namespace: 'users' });

    const firstCtx = makeContext();
    const secondCtx = makeContext();
    const first = decorated(makeRequest(), firstCtx);
    const second = decorated(makeRequest(), secondCtx);

    gate.resolve('shared');

    await expect(first).resolves.toBe('shared');
    await expect(second).resolves.toBe('shared');
    expect(op).toHaveBeenCalledTimes(1);
    expect(firstCtx.meta).toEqual({ cache: 'miss' });
    expect(secondCtx.meta).toEqual({ cache: 'coalesced' });
  });

  it('does not coalesce two different keys', async () => {
    const op = jest.fn(async (req: Request) => req.originalUrl);
    const decorated = withCache(op, { ttlMs: 1_000, namespace: 'users' });

    await Promise.all([
      decorated(makeRequest({ originalUrl: '/v1/users/1' }), makeContext()),
      decorated(makeRequest({ originalUrl: '/v1/users/2' }), makeContext()),
    ]);

    expect(op).toHaveBeenCalledTimes(2);
  });

  it('releases the in-flight slot after a rejection so the next caller retries', async () => {
    const gate = deferred<string>();
    const op = jest.fn<Promise<string>, []>().mockReturnValueOnce(gate.promise).mockResolvedValue('ok');
    const decorated = withCache(op, { ttlMs: 1_000, namespace: 'users' });

    const failing = decorated(makeRequest(), makeContext()).catch((err: unknown) => err);
    gate.reject(new Error('boom'));
    await failing;

    await expect(decorated(makeRequest(), makeContext())).resolves.toBe('ok');
    expect(op).toHaveBeenCalledTimes(2);
  });

  it('scopes keys by namespace so two routes sharing a store do not collide', async () => {
    const store = new MemoryCacheStore();
    const users = withCache(async () => 'users-result', {
      ttlMs: 1_000,
      namespace: 'users',
      store,
    });
    const posts = withCache(async () => 'posts-result', {
      ttlMs: 1_000,
      namespace: 'posts',
      store,
    });

    const sameUrl = makeRequest({ originalUrl: '/v1/thing' });
    await expect(users(sameUrl, makeContext())).resolves.toBe('users-result');
    await expect(posts(sameUrl, makeContext())).resolves.toBe('posts-result');
  });

  it('is invalidated by clearing the shared store', async () => {
    const store = new MemoryCacheStore();
    const op = jest.fn<Promise<string>, []>().mockResolvedValueOnce('stale').mockResolvedValue('fresh');
    const decorated = withCache(op, { ttlMs: 10_000, namespace: 'users', store });

    await expect(decorated(makeRequest(), makeContext())).resolves.toBe('stale');
    await store.clear();
    await expect(decorated(makeRequest(), makeContext())).resolves.toBe('fresh');
  });

  it('honours a custom key function', async () => {
    const op = jest.fn(async () => 'v');
    const decorated = withCache(op, {
      ttlMs: 1_000,
      namespace: 'users',
      // Ignores the query string on purpose.
      key: (req) => req.originalUrl.split('?')[0] ?? req.originalUrl,
    });

    await decorated(makeRequest({ originalUrl: '/v1/users?a=1' }), makeContext());
    const ctx = makeContext();
    await decorated(makeRequest({ originalUrl: '/v1/users?a=2' }), ctx);

    expect(ctx.meta).toEqual({ cache: 'hit' });
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('rejects a nonsensical TTL at wiring time', () => {
    const op = async (): Promise<string> => 'x';

    expect(() => withCache(op, { ttlMs: 0, namespace: 'n' })).toThrow(RangeError);
    expect(() => withCache(op, { ttlMs: -5, namespace: 'n' })).toThrow(RangeError);
  });
});
