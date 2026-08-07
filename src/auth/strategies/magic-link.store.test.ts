import { createInMemoryMagicLinkStore } from '@/auth/strategies/magic-link.store';
import type { InspectableMagicLinkStore } from '@/auth/strategies/magic-link.store';

const TTL_SECONDS = 900;

function makeStore(startAt = 1_000_000): {
  store: InspectableMagicLinkStore;
  advance: (seconds: number) => void;
} {
  let clock = startAt;
  return {
    store: createInMemoryMagicLinkStore({ ttlSeconds: TTL_SECONDS, now: () => clock }),
    advance: (seconds: number): void => {
      clock += seconds * 1000;
    },
  };
}

describe('createInMemoryMagicLinkStore', () => {
  it('returns the email a token was issued to', async () => {
    const { store } = makeStore();
    await store.issue('hash-a', 'user@example.com');

    await expect(store.consume('hash-a')).resolves.toBe('user@example.com');
  });

  it('returns null for a digest it never issued', async () => {
    const { store } = makeStore();

    await expect(store.consume('never-seen')).resolves.toBeNull();
  });

  it('is single-use: the second consume finds nothing', async () => {
    const { store } = makeStore();
    await store.issue('hash-a', 'user@example.com');

    await expect(store.consume('hash-a')).resolves.toBe('user@example.com');
    await expect(store.consume('hash-a')).resolves.toBeNull();
  });

  it('rejects a token consumed exactly at its expiry', async () => {
    const { store, advance } = makeStore();
    await store.issue('hash-a', 'user@example.com');

    advance(TTL_SECONDS);

    await expect(store.consume('hash-a')).resolves.toBeNull();
  });

  it('still honours a token one second before expiry', async () => {
    const { store, advance } = makeStore();
    await store.issue('hash-a', 'user@example.com');

    advance(TTL_SECONDS - 1);

    await expect(store.consume('hash-a')).resolves.toBe('user@example.com');
  });

  it('drops an expired record rather than leaving it to be retried', async () => {
    const { store, advance } = makeStore();
    await store.issue('hash-a', 'user@example.com');

    advance(TTL_SECONDS + 1);
    await store.consume('hash-a');

    expect(store.size).toBe(0);
  });

  it('invalidates the previous link when the same address asks again', async () => {
    const { store } = makeStore();
    await store.issue('hash-a', 'user@example.com');
    await store.issue('hash-b', 'user@example.com');

    await expect(store.consume('hash-a')).resolves.toBeNull();
    await expect(store.consume('hash-b')).resolves.toBe('user@example.com');
  });

  it('leaves another address untouched when one reissues', async () => {
    const { store } = makeStore();
    await store.issue('hash-a', 'first@example.com');
    await store.issue('hash-b', 'second@example.com');
    await store.issue('hash-c', 'first@example.com');

    await expect(store.consume('hash-b')).resolves.toBe('second@example.com');
    await expect(store.consume('hash-c')).resolves.toBe('first@example.com');
  });

  it('counts only outstanding links', async () => {
    const { store } = makeStore();
    expect(store.size).toBe(0);

    await store.issue('hash-a', 'a@example.com');
    await store.issue('hash-b', 'b@example.com');
    expect(store.size).toBe(2);

    await store.consume('hash-a');
    expect(store.size).toBe(1);
  });

  it('clears every outstanding link', async () => {
    const { store } = makeStore();
    await store.issue('hash-a', 'a@example.com');
    await store.issue('hash-b', 'b@example.com');

    store.clear();

    expect(store.size).toBe(0);
    await expect(store.consume('hash-a')).resolves.toBeNull();
  });

  it('defaults to the wall clock when none is injected', async () => {
    const store = createInMemoryMagicLinkStore({ ttlSeconds: TTL_SECONDS });
    await store.issue('hash-a', 'user@example.com');

    await expect(store.consume('hash-a')).resolves.toBe('user@example.com');
  });
});
