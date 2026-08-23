/**
 * Pure derivation for values you are not allowed to write to.
 *
 * Deliberately three functions and no more. Once a structure is frozen the
 * question "how do I change it?" has one general answer — build a new one — and
 * the object spread is already that answer for the common case. What is
 * collected here is only what spread does badly:
 *
 * - `patch` returns the *same reference* when nothing actually changed. Spread
 *   always allocates, so `{ ...row, ...body }` produces a new object for a
 *   no-op update, and every `===` downstream (a cache key, a memo, a "did this
 *   change?" check) reports a change that did not happen.
 * - `omit` and `pick` are the two shapes spread cannot express at all. The
 *   usual hand-rolled `omit` is `const rest = { ...value }; delete rest[key]`,
 *   which needs the intermediate to be widened to a `Record` before `delete`
 *   is legal — so the return type stops being checked exactly where it matters.
 *
 * **There are deliberately no array helpers here.** `with`, `toSorted`,
 * `toSpliced` and `toReversed` are the standard library's copying array
 * methods, they are declared on `ReadonlyArray` as well as `Array`, and every
 * Node version this package supports (`^22.12 || ^24`) ships them. That is why
 * `tsconfig.json` names `ES2023` in `lib` — with `ES2022` TypeScript denies
 * they exist, and the gap gets filled by a hand-written `replaceAt` that is
 * strictly worse than the method it shadows.
 */

/**
 * The keys an object spread would copy: own, enumerable, strings and symbols.
 *
 * Written out rather than `Object.keys` because `patch` compares the keys it is
 * about to spread, and if the two disagree a symbol-keyed change is spread in
 * while the comparison says nothing changed — and `patch` returns the old
 * object with the new value silently dropped.
 */
function ownEnumerableKeys(value: object): (string | symbol)[] {
  const keys: (string | symbol)[] = Object.keys(value);
  for (const symbol of Object.getOwnPropertySymbols(value)) {
    if (Object.prototype.propertyIsEnumerable.call(value, symbol)) keys.push(symbol);
  }
  return keys;
}

/**
 * `value` with `changes` applied, or `value` itself when they change nothing.
 *
 * Comparison is `Object.is` per key, which is shallow on purpose: a deep
 * comparison would turn a cheap merge into a walk of both structures, and the
 * case it would catch — a nested object rebuilt to an equal shape — is one the
 * caller created by rebuilding it.
 *
 * A key present in `changes` with the value `undefined` is applied, not
 * ignored, exactly as the spread would apply it. "Set this to undefined" and
 * "leave this alone" are different requests and the second one is spelled by
 * leaving the key out.
 *
 * The result is a new, *unfrozen* object. Somewhere to put it that other code
 * can see means freezing it again on the way in — see `deepFreeze`.
 */
export function patch<T extends object>(value: T, changes: Readonly<Partial<T>>): T {
  const keys = ownEnumerableKeys(changes) as (keyof T)[];

  let differs = false;
  for (const key of keys) {
    if (!Object.is(value[key], changes[key])) {
      differs = true;
      break;
    }
  }

  if (!differs) return value;

  return { ...value, ...changes };
}

/**
 * `value` without `keys`.
 *
 * The single cast is the same one every `omit` needs: the result is assembled
 * key by key as an untyped record, because there is no way to build an
 * `Omit<T, K>` incrementally that the compiler can follow. What it is *not* is
 * the `delete` version's cast, which widens the value being mutated and
 * therefore stops checking the keys being removed against `T`; the signature
 * here rejects `omit(user, 'emial')` at the call site.
 */
export function omit<T extends object, K extends keyof T>(
  value: T,
  ...keys: readonly K[]
): Omit<T, K> {
  const dropped = new Set<string | symbol>(keys as readonly (string | symbol)[]);
  const result: Record<string | symbol, unknown> = {};

  for (const key of ownEnumerableKeys(value)) {
    if (dropped.has(key)) continue;
    result[key] = (value as Record<string | symbol, unknown>)[key];
  }

  return result as Omit<T, K>;
}

/**
 * Just `keys`, and only the ones `value` actually has.
 *
 * The `hasOwnProperty` guard is what keeps an absent optional property absent
 * instead of present-and-`undefined`. The two are indistinguishable through a
 * property read and very distinguishable through `JSON.stringify`, `in`, and a
 * spread that is meant to leave a default in place.
 */
export function pick<T extends object, K extends keyof T>(
  value: T,
  ...keys: readonly K[]
): Pick<T, K> {
  const result: Record<string | symbol, unknown> = {};

  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      result[key as string | symbol] = value[key];
    }
  }

  return result as Pick<T, K>;
}
