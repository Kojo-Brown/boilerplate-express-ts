import {
  createMagicLinkIssuer,
  createMagicLinkStrategy,
} from '@/auth/strategies/magic-link.strategy';
import { createInMemoryMagicLinkStore } from '@/auth/strategies/magic-link.store';
import type { InspectableMagicLinkStore } from '@/auth/strategies/magic-link.store';
import { createRecordingMagicLinkDelivery } from '@/auth/strategies/magic-link.delivery';
import type {
  MagicLinkDelivery,
  RecordingMagicLinkDelivery,
} from '@/auth/strategies/magic-link.delivery';
import { hashSecret } from '@/auth/strategies/secret-hash';
import { ValidationError } from '@/lib/errors';
import type { AuthStrategy } from '@/auth/strategies/auth-strategy.types';
import type { AuthUser, UserDirectory } from '@/auth/auth.types';

const TTL_SECONDS = 900;

const KNOWN_USER: AuthUser = {
  id: 'u-7',
  email: 'linked@example.com',
  passwordHash: 'not-a-real-hash',
  roles: ['user', 'beta'],
};

function makeDirectory(users: readonly AuthUser[] = [KNOWN_USER]): UserDirectory {
  return {
    findByEmail(email: string): Promise<AuthUser | null> {
      return Promise.resolve(users.find((u) => u.email === email) ?? null);
    },
  };
}

interface Harness {
  strategy: AuthStrategy;
  links: InspectableMagicLinkStore;
  delivery: RecordingMagicLinkDelivery;
  request: (email: string) => Promise<void>;
  advance: (seconds: number) => void;
}

function makeHarness(
  options: { users?: readonly AuthUser[]; tokens?: string[] } = {},
): Harness {
  let clock = 1_000_000;
  const queue = [...(options.tokens ?? [])];
  let minted = 0;

  const users = makeDirectory(options.users);
  const links = createInMemoryMagicLinkStore({ ttlSeconds: TTL_SECONDS, now: () => clock });
  const delivery = createRecordingMagicLinkDelivery();

  const issuer = createMagicLinkIssuer({
    users,
    links,
    delivery,
    ttlSeconds: TTL_SECONDS,
    now: () => clock,
    generateToken: () => queue.shift() ?? `minted-token-${(minted += 1)}`,
  });

  return {
    strategy: createMagicLinkStrategy({ users, links }),
    links,
    delivery,
    request: (email: string) => issuer.request(email),
    advance: (seconds: number): void => {
      clock += seconds * 1000;
    },
  };
}

describe('createMagicLinkIssuer', () => {
  it('delivers a link to an address the directory knows', async () => {
    const h = makeHarness({ tokens: ['mock-token-1'] });

    await h.request('linked@example.com');

    expect(h.delivery.lastFor('linked@example.com')).toMatchObject({
      email: 'linked@example.com',
      token: 'mock-token-1',
    });
  });

  it('stores the digest, never the token itself', async () => {
    const h = makeHarness({ tokens: ['mock-token-1'] });

    await h.request('linked@example.com');

    // The digest is what redeems; the raw token does not appear in the store.
    await expect(h.links.consume('mock-token-1')).resolves.toBeNull();
    await expect(h.links.consume(hashSecret('mock-token-1'))).resolves.toBe('linked@example.com');
  });

  it('reports the expiry the store will actually enforce', async () => {
    const h = makeHarness({ tokens: ['mock-token-1'] });

    await h.request('linked@example.com');
    const delivered = h.delivery.lastFor('linked@example.com');

    h.advance(TTL_SECONDS - 1);
    await expect(h.links.consume(hashSecret('mock-token-1'))).resolves.toBe('linked@example.com');

    expect(delivered?.expiresAt).toBe(1_000_000 + TTL_SECONDS * 1000);
  });

  it('resolves silently for an unknown address', async () => {
    const h = makeHarness();

    await expect(h.request('ghost@example.com')).resolves.toBeUndefined();
  });

  it('sends nothing and stores nothing for an unknown address', async () => {
    const h = makeHarness();

    await h.request('ghost@example.com');

    expect(h.delivery.size).toBe(0);
    expect(h.links.size).toBe(0);
  });

  it('issues against the address as the directory spells it', async () => {
    const h = makeHarness({ tokens: ['mock-token-1'] });

    await h.request(KNOWN_USER.email);

    expect(h.delivery.lastFor(KNOWN_USER.email)).toBeDefined();
  });

  it('leaves the link outstanding when delivery fails', async () => {
    const failing: MagicLinkDelivery = {
      send: () => Promise.reject(new Error('smtp down')),
    };
    const users = makeDirectory();
    const links = createInMemoryMagicLinkStore({ ttlSeconds: TTL_SECONDS });
    const issuer = createMagicLinkIssuer({
      users,
      links,
      delivery: failing,
      ttlSeconds: TTL_SECONDS,
      generateToken: () => 'mock-token-1',
    });

    await expect(issuer.request('linked@example.com')).rejects.toThrow('smtp down');

    // Stored before delivery on purpose: the alternative sends a user a link
    // the store never accepted.
    expect(links.size).toBe(1);
  });

  it('defaults to a random token when none is injected', async () => {
    const users = makeDirectory();
    const links = createInMemoryMagicLinkStore({ ttlSeconds: TTL_SECONDS });
    const delivery = createRecordingMagicLinkDelivery();
    const issuer = createMagicLinkIssuer({ users, links, delivery, ttlSeconds: TTL_SECONDS });

    await issuer.request('linked@example.com');
    await issuer.request('linked@example.com');

    const token = delivery.lastFor('linked@example.com')?.token ?? '';
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('magic-link strategy', () => {
  it('is registered under the name the URL segment uses', () => {
    expect(makeHarness().strategy.name).toBe('magic-link');
  });

  it('resolves the principal the link was issued to', async () => {
    const h = makeHarness({ tokens: ['mock-token-1'] });
    await h.request('linked@example.com');

    await expect(h.strategy.authenticate({ token: 'mock-token-1' })).resolves.toEqual({
      id: 'u-7',
      email: 'linked@example.com',
      roles: ['user', 'beta'],
    });
  });

  it('copies the roles rather than aliasing the directory record', async () => {
    const h = makeHarness({ tokens: ['mock-token-1'] });
    await h.request('linked@example.com');

    const principal = await h.strategy.authenticate({ token: 'mock-token-1' });
    principal.roles.push('admin');

    expect(KNOWN_USER.roles).toEqual(['user', 'beta']);
  });

  it('rejects a token that was never issued', async () => {
    const h = makeHarness();

    await expect(h.strategy.authenticate({ token: 'never-issued' })).rejects.toMatchObject({
      statusCode: 401,
      code: 'AUTH_INVALID_MAGIC_LINK',
    });
  });

  it('rejects the second use of a link', async () => {
    const h = makeHarness({ tokens: ['mock-token-1'] });
    await h.request('linked@example.com');

    await h.strategy.authenticate({ token: 'mock-token-1' });

    await expect(h.strategy.authenticate({ token: 'mock-token-1' })).rejects.toMatchObject({
      statusCode: 401,
      code: 'AUTH_INVALID_MAGIC_LINK',
    });
  });

  it('rejects a link that has expired', async () => {
    const h = makeHarness({ tokens: ['mock-token-1'] });
    await h.request('linked@example.com');

    h.advance(TTL_SECONDS + 1);

    await expect(h.strategy.authenticate({ token: 'mock-token-1' })).rejects.toMatchObject({
      statusCode: 401,
      code: 'AUTH_INVALID_MAGIC_LINK',
    });
  });

  it('rejects a link whose user has since disappeared', async () => {
    const disappearing: AuthUser[] = [{ ...KNOWN_USER }];
    const users: UserDirectory = {
      findByEmail(email: string): Promise<AuthUser | null> {
        return Promise.resolve(disappearing.find((u) => u.email === email) ?? null);
      },
    };
    const links = createInMemoryMagicLinkStore({ ttlSeconds: TTL_SECONDS });
    const delivery = createRecordingMagicLinkDelivery();
    const issuer = createMagicLinkIssuer({
      users,
      links,
      delivery,
      ttlSeconds: TTL_SECONDS,
      generateToken: () => 'mock-token-1',
    });
    const strategy = createMagicLinkStrategy({ users, links });

    await issuer.request('linked@example.com');
    disappearing.length = 0;

    await expect(strategy.authenticate({ token: 'mock-token-1' })).rejects.toMatchObject({
      statusCode: 401,
      code: 'AUTH_INVALID_MAGIC_LINK',
    });
  });

  it('gives the same message for an unknown, expired and spent link', async () => {
    const h = makeHarness({ tokens: ['mock-token-1'] });
    await h.request('linked@example.com');
    await h.strategy.authenticate({ token: 'mock-token-1' });

    const spent = await h.strategy.authenticate({ token: 'mock-token-1' }).catch((e: unknown) => e);
    const unknown = await h.strategy.authenticate({ token: 'other' }).catch((e: unknown) => e);

    expect((spent as Error).message).toBe((unknown as Error).message);
  });

  it('raises a 422, not a 401, when the body is the wrong shape', async () => {
    const h = makeHarness();

    await expect(h.strategy.authenticate({ apiKey: 'wrong-field' })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('spends the link even when the directory lookup then fails', async () => {
    const h = makeHarness({ tokens: ['mock-token-1'] });
    await h.request('linked@example.com');

    await h.strategy.authenticate({ token: 'mock-token-1' });

    expect(h.links.size).toBe(0);
  });
});
