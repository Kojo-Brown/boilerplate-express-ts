import type { DeepReadonly } from '@/lib/immutable/deep-readonly';

/**
 * Objects `deepFreeze` walks past without freezing.
 *
 * Freezing these ranges from pointless to harmful. A `Date`'s time and an
 * `ArrayBuffer`'s bytes live in internal slots, so `Object.freeze` returns a
 * value that still answers `setTime`; a frozen `Error` cannot have `stack`
 * written to it, and V8 writes that lazily on first read; a frozen `Promise` is
 * a promise some library can no longer attach its own bookkeeping to. In every
 * case the freeze buys nothing and removes an operation somebody depends on.
 *
 * Matched by `Object.prototype.toString` rather than `instanceof` because a
 * value that arrived from a worker thread was constructed in that thread's
 * realm, so its prototype is not this realm's `Date.prototype` — and this
 * service does move structured-cloned values across that boundary.
 */
const LEAF_TAGS: ReadonlySet<string> = new Set([
  '[object Date]',
  '[object RegExp]',
  '[object Error]',
  '[object Promise]',
  '[object ArrayBuffer]',
  '[object SharedArrayBuffer]',
  '[object WeakMap]',
  '[object WeakSet]',
  '[object WeakRef]',
]);

const MAP_TAG = '[object Map]';
const SET_TAG = '[object Set]';

function freezeInto(value: unknown, seen: WeakSet<object>): void {
  if (value === null || typeof value !== 'object') {
    // Functions land here too, and are left alone on purpose: a frozen function
    // rejects the property assignment that decorators, memoisers and test
    // doubles all make, and it has no data of its own to protect.
    return;
  }

  // Covers every typed array and `DataView`. This one is not merely pointless:
  // `Object.freeze(new Uint8Array([1]))` *throws*, because the indices are
  // integer-indexed exotic properties that cannot be made non-configurable. A
  // `Buffer` reaching a cached response would otherwise turn a dev-mode check
  // into a dev-mode crash.
  if (ArrayBuffer.isView(value)) return;

  const tag = Object.prototype.toString.call(value);
  if (LEAF_TAGS.has(tag)) return;

  // Cycles, and the diamond where two properties reference one object.
  if (seen.has(value)) return;
  seen.add(value);

  // `Map` and `Set` keep their entries in internal slots, so freezing the
  // container does not stop `set`/`add` — `ReadonlyMap` and `ReadonlySet` from
  // `DeepReadonly` are what does. The contents are still ordinary objects and
  // do get the runtime guarantee.
  if (tag === MAP_TAG) {
    for (const [key, entry] of value as ReadonlyMap<unknown, unknown>) {
      freezeInto(key, seen);
      freezeInto(entry, seen);
    }
    return;
  }

  if (tag === SET_TAG) {
    for (const entry of value as ReadonlySet<unknown>) freezeInto(entry, seen);
    return;
  }

  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    // Accessors are skipped rather than read. Invoking an unknown getter to
    // find out whether its result needs freezing is a side effect this function
    // has no licence to cause, and the value it returns is usually computed per
    // call and not part of the structure at all.
    if (descriptor === undefined || !('value' in descriptor)) continue;
    freezeInto(descriptor.value, seen);
  }

  Object.freeze(value);
}

/**
 * Freeze a structure and everything reachable from it, in place.
 *
 * In place, and returning the same reference, because the alternative — freeze
 * a clone — makes the original an unfrozen copy that some other holder is still
 * writing to, which is the bug this is meant to expose rather than duplicate.
 *
 * The guarantee is worth stating precisely, because `Object.freeze` is weaker
 * than it sounds. On a plain object or an array it is real: an assignment
 * throws `TypeError` under strict mode, which every file here compiles to. On a
 * `Date`, `Map`, `Set` or `Buffer` it is nothing at all, so this function does
 * not pretend — it leaves them alone and `DeepReadonly` types them so the
 * compiler refuses the mutators instead.
 *
 * Use it for values with more than one holder and no owner: configuration,
 * a cached response, a payload fanned out to subscribers. Do not use it on a
 * live collaborator — a pool, a store, a class with internal state — because
 * freezing one is how you find out at runtime which of its fields it assigns.
 */
export function deepFreeze<T>(value: T): DeepReadonly<T> {
  freezeInto(value, new WeakSet());
  // `DeepReadonly<T>` is `T` with modifiers added: the same object, described
  // more narrowly. TypeScript cannot evaluate the mapped type while `T` is
  // still a parameter, so it cannot see that for itself.
  return value as unknown as DeepReadonly<T>;
}
