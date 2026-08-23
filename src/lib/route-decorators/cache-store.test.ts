import { MemoryCacheStore } from '@/lib/route-decorators/cache-store';

/** A hand-cranked clock so TTL behaviour is asserted, not waited for. */
function makeClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('MemoryCacheStore', () => {
  it('round-trips a value inside its TTL', async () => {
    const store = new MemoryCacheStore({ now: makeClock().now });
    await store.set('k', { id: 1 }, 1_000);

    await expect(store.get<{ id: number }>('k')).resolves.toEqual({ value: { id: 1 } });
  });

  it('reports a miss as undefined rather than a box', async () => {
    const store = new MemoryCacheStore();
    await expect(store.get('absent')).resolves.toBeUndefined();
  });

  it('distinguishes a cached `undefined` from a miss', async () => {
    const store = new MemoryCacheStore();
    await store.set('k', undefined, 1_000);

    // The box is the whole point: without it this is indistinguishable from
    // the miss asserted above, and the operation re-runs on every request.
    await expect(store.get('k')).resolves.toEqual({ value: undefined });
  });

  it('expires an entry once the clock passes its TTL', async () => {
    const clock = makeClock();
    const store = new MemoryCacheStore({ now: clock.now });
    await store.set('k', 'v', 1_000);

    clock.advance(999);
    await expect(store.get('k')).resolves.toEqual({ value: 'v' });

    clock.advance(1);
    await expect(store.get('k')).resolves.toBeUndefined();
  });

  it('drops the expired entry on read instead of leaving it to accumulate', async () => {
    const clock = makeClock();
    const store = new MemoryCacheStore({ now: clock.now });
    await store.set('k', 'v', 100);

    clock.advance(200);
    await store.get('k');

    expect(store.size).toBe(0);
  });

  it('deletes and clears', async () => {
    const store = new MemoryCacheStore();
    await store.set('a', 1, 1_000);
    await store.set('b', 2, 1_000);

    await store.delete('a');
    await expect(store.get('a')).resolves.toBeUndefined();
    await expect(store.get('b')).resolves.toEqual({ value: 2 });

    await store.clear();
    await expect(store.get('b')).resolves.toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('overwrites rather than duplicating on re-set', async () => {
    const store = new MemoryCacheStore();
    await store.set('k', 'first', 1_000);
    await store.set('k', 'second', 1_000);

    await expect(store.get('k')).resolves.toEqual({ value: 'second' });
    expect(store.size).toBe(1);
  });

  it('sacrifices expired entries before live ones when full', async () => {
    const clock = makeClock();
    const store = new MemoryCacheStore({ maxEntries: 2, now: clock.now });

    await store.set('short', 'a', 100);
    await store.set('long', 'b', 10_000);
    clock.advance(200);

    await store.set('new', 'c', 10_000);

    await expect(store.get('short')).resolves.toBeUndefined();
    await expect(store.get('long')).resolves.toEqual({ value: 'b' });
    await expect(store.get('new')).resolves.toEqual({ value: 'c' });
  });

  it('evicts the least recently used entry when everything is live', async () => {
    const store = new MemoryCacheStore({ maxEntries: 2, now: makeClock().now });

    await store.set('a', 1, 10_000);
    await store.set('b', 2, 10_000);
    // Reading 'a' makes 'b' the least recently used, so 'b' is what goes.
    await store.get('a');
    await store.set('c', 3, 10_000);

    await expect(store.get('a')).resolves.toEqual({ value: 1 });
    await expect(store.get('b')).resolves.toBeUndefined();
    await expect(store.get('c')).resolves.toEqual({ value: 3 });
  });

  it('never exceeds maxEntries, so an attacker varying the key cannot grow it', async () => {
    const store = new MemoryCacheStore({ maxEntries: 10, now: makeClock().now });

    for (let i = 0; i < 500; i += 1) {
      await store.set(`key-${i}`, i, 10_000);
    }

    expect(store.size).toBe(10);
  });

  it('rejects a nonsensical configuration at construction', () => {
    expect(() => new MemoryCacheStore({ maxEntries: 0 })).toThrow(RangeError);
    expect(() => new MemoryCacheStore({ maxEntries: 2.5 })).toThrow(RangeError);
  });

  it('rejects a nonsensical TTL on write', async () => {
    const store = new MemoryCacheStore();
    expect(() => store.set('k', 'v', 0)).toThrow(RangeError);
    expect(() => store.set('k', 'v', -1)).toThrow(RangeError);
    await expect(store.get('k')).resolves.toBeUndefined();
  });
});

describe('MemoryCacheStore — the shared reference', () => {
  it('stores the value itself, so every hit is the same object', async () => {
    const store = new MemoryCacheStore();
    const rows = [{ id: 'a' }];
    await store.set('k', rows, 1_000);

    const first = await store.get<{ id: string }[]>('k');
    const second = await store.get<{ id: string }[]>('k');

    // Not an implementation detail: it is the reason for the freeze below.
    expect(first?.value).toBe(rows);
    expect(second?.value).toBe(rows);
  });

  it('freezes what it stores, outside production', async () => {
    const store = new MemoryCacheStore();
    const rows = [{ id: 'a' }];
    await store.set('k', rows, 1_000);

    const hit = await store.get<{ id: string }[]>('k');

    // No cast and no `@ts-expect-error`: the type says `{ id: string }[]` and
    // always did. That is exactly the hole — the caller who edits a cached row
    // is writing code the compiler is happy with, and the entry stays edited
    // until the TTL runs out. The freeze turns it into a throw at the line that
    // did it, in the test that did it.
    expect(() => {
      hit!.value[0]!.id = 'b';
    }).toThrow(TypeError);

    expect(rows[0]?.id).toBe('a');
  });

  it('freezes the writer’s own object, not a copy of it', async () => {
    const store = new MemoryCacheStore();
    const rows = [{ id: 'a' }];
    await store.set('k', rows, 1_000);

    // The first request is the one holding the object it just cached, so it is
    // also the one most likely to mutate it. Deferring the freeze until a
    // second request could observe the damage would report the bug against
    // whichever test happened to read the entry next.
    expect(Object.isFrozen(rows)).toBe(true);
    expect(Object.isFrozen(rows[0])).toBe(true);
  });
});
