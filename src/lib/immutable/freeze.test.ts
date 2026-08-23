import { deepFreeze } from '@/lib/immutable/freeze';
import { FREEZE_IN_DEV, freezeInDev } from '@/lib/immutable/dev-freeze';

describe('deepFreeze — what it protects', () => {
  it('freezes nested objects, not just the root', () => {
    const value = deepFreeze({ user: { profile: { displayName: 'Ada' } } });

    // Every file here compiles with `alwaysStrict` (implied by `strict`), so a
    // write to a frozen object throws rather than failing silently. That is
    // what makes this a check and not a suggestion.
    expect(() => {
      // @ts-expect-error — the type refuses this too; the test is that the
      // runtime does, for the callers whose types were erased on the way in.
      value.user.profile.displayName = 'Grace';
    }).toThrow(TypeError);

    expect(value.user.profile.displayName).toBe('Ada');
  });

  it('freezes arrays and their elements', () => {
    const value = deepFreeze({ rows: [{ id: 'a' }] });

    expect(() => value.rows[0]!.id).not.toThrow();
    expect(Object.isFrozen(value.rows)).toBe(true);
    expect(Object.isFrozen(value.rows[0])).toBe(true);
  });

  it('returns the same reference rather than a frozen copy', () => {
    const original = { id: 'a' };

    // A frozen clone would leave `original` writable and in somebody's hands,
    // which is the bug rather than the fix.
    expect(deepFreeze(original)).toBe(original);
  });

  it('freezes non-enumerable and symbol-keyed properties', () => {
    const marker = Symbol('marker');
    const value: Record<string | symbol, unknown> = { [marker]: { n: 1 } };
    Object.defineProperty(value, 'hidden', { value: { n: 2 }, enumerable: false });

    deepFreeze(value);

    expect(Object.isFrozen(value[marker])).toBe(true);
    expect(Object.isFrozen(value['hidden'])).toBe(true);
  });

  it('freezes class instances', () => {
    class Row {
      constructor(public id: string) {}
    }

    const row = deepFreeze(new Row('a'));

    expect(() => {
      // @ts-expect-error — `DeepReadonly` has already made this an error.
      row.id = 'b';
    }).toThrow(TypeError);
  });
});

describe('deepFreeze — what it walks past', () => {
  it('survives a cycle', () => {
    type Node = { name: string; parent?: Node };
    const parent: Node = { name: 'parent' };
    const child: Node = { name: 'child', parent };
    parent.parent = child;

    expect(() => deepFreeze(parent)).not.toThrow();
    expect(Object.isFrozen(child)).toBe(true);
  });

  it('visits a shared child once', () => {
    const shared = { n: 1 };
    const value = deepFreeze({ left: shared, right: shared });

    expect(value.left).toBe(value.right);
    expect(Object.isFrozen(shared)).toBe(true);
  });

  it('does not throw on a typed array, and does not freeze it', () => {
    const bytes = Buffer.from('mock-upload-bytes');
    const value = { checksum: 'sha256:0000', bytes };

    // `Object.freeze` on a typed array with elements throws: its indices are
    // integer-indexed exotic properties and cannot be made non-configurable.
    // Left unhandled, a `Buffer` in a cached response would turn this check
    // into a crash — in dev only, which is the worst place to find out.
    expect(() => deepFreeze(value)).not.toThrow();
    expect(Object.isFrozen(bytes)).toBe(false);
    expect(Object.isFrozen(value)).toBe(true);
  });

  it('leaves a Date writable rather than pretending otherwise', () => {
    const createdAt = new Date('2024-05-01T12:00:00.000Z');
    const value = deepFreeze({ createdAt });

    expect(Object.isFrozen(value.createdAt)).toBe(false);

    // The honest statement of the guarantee: the *property* cannot be replaced,
    // the `Date` itself can still be moved. Freezing it would not have changed
    // that — the time lives in an internal slot — it would only have looked
    // like it did.
    value.createdAt.setUTCFullYear(2030);
    expect(value.createdAt.getUTCFullYear()).toBe(2030);
  });

  it('leaves an Error alone so its stack can still be written', () => {
    const error = new Error('mock failure');
    deepFreeze({ error });

    expect(Object.isFrozen(error)).toBe(false);
  });

  it('leaves functions alone', () => {
    const fn = (): number => 1;
    deepFreeze({ fn });

    expect(Object.isFrozen(fn)).toBe(false);
  });

  it('freezes what a Map holds without freezing the Map', () => {
    const entry = { id: 'a' };
    const byId = new Map([['a', entry]]);
    deepFreeze({ byId });

    // Freezing the container would be theatre — `set` writes to an internal
    // slot and ignores it. `DeepReadonly` maps this to `ReadonlyMap`, which is
    // where that half of the guarantee lives.
    expect(byId.set('b', { id: 'b' })).toBe(byId);
    expect(Object.isFrozen(entry)).toBe(true);
  });

  it('freezes what a Set holds without freezing the Set', () => {
    const entry = { id: 'a' };
    const seen = new Set([entry]);
    deepFreeze({ seen });

    expect(() => seen.add({ id: 'b' })).not.toThrow();
    expect(Object.isFrozen(entry)).toBe(true);
  });

  it('does not invoke a getter to decide whether to freeze its result', () => {
    let reads = 0;
    const value = {
      get expensive(): { n: number } {
        reads += 1;
        return { n: reads };
      },
    };

    deepFreeze(value);

    // Reading an unknown accessor is a side effect this has no licence to
    // cause, and the object it returns is usually rebuilt per call anyway.
    expect(reads).toBe(0);
    expect(Object.isFrozen(value)).toBe(true);
  });

  it('accepts primitives without complaint', () => {
    expect(deepFreeze(null)).toBeNull();
    expect(deepFreeze(undefined)).toBeUndefined();
    expect(deepFreeze(42)).toBe(42);
  });
});

describe('freezeInDev', () => {
  it('is enabled under NODE_ENV=test, where a mutation is reproducible', () => {
    expect(FREEZE_IN_DEV).toBe(true);
  });

  it('returns its argument and freezes it', () => {
    const value = { nested: { n: 1 } };

    expect(freezeInDev(value)).toBe(value);
    expect(Object.isFrozen(value.nested)).toBe(true);
  });

  it('is an identity function in production', () => {
    const previous = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    jest.resetModules();

    try {
      // `require` rather than a static import because the whole point is to
      // re-evaluate the module against a different `NODE_ENV`: the flag is read
      // once at load, so an import hoisted to the top of this file would have
      // captured the test value before the line above ran.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const reloaded = require('@/lib/immutable/dev-freeze') as typeof import('@/lib/immutable/dev-freeze');

      expect(reloaded.FREEZE_IN_DEV).toBe(false);

      const value = { nested: { n: 1 } };
      expect(reloaded.freezeInDev(value)).toBe(value);
      expect(Object.isFrozen(value)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = previous;
      jest.resetModules();
    }
  });
});
