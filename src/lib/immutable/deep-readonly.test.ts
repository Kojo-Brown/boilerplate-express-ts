import type { DeepReadonly } from '@/lib/immutable/deep-readonly';

/**
 * Exact type equality, not mutual assignability.
 *
 * `A extends B ? B extends A ? true : false : false` is the obvious version and
 * it is useless here, because TypeScript ignores `readonly` property modifiers
 * when it checks assignability: `{ a: string }` and `{ readonly a: string }`
 * are mutually assignable, so the obvious version reports success for a
 * `DeepReadonly` that did nothing at all. Comparing two deferred conditional
 * types forces the compiler to compare the types *structurally*, modifiers
 * included, which is the only form that can fail here.
 */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/**
 * Compiles only when `T` is exactly `true`.
 *
 * The assertion is the compilation: a mismatch is rejected at the type
 * argument, so it surfaces as a `pnpm typecheck` failure rather than a red
 * test. The value is threaded through so each `it` below still ends in a
 * runtime expectation and reads like the rest of the suite.
 */
function assertType<T extends true>(witness: T): T {
  return witness;
}

/** The negative form, for showing what a weaker type does *not* give you. */
function assertNotType<T extends false>(witness: T): T {
  return witness;
}

describe('DeepReadonly — nesting', () => {
  it('marks nested properties readonly, not just the outermost ones', () => {
    type Input = { user: { email: string; profile: { displayName: string } } };
    type Expected = {
      readonly user: { readonly email: string; readonly profile: { readonly displayName: string } };
    };

    // The failure this is about: the shallow `Readonly` is not this type. It
    // freezes the outermost layer and leaves `value.user.email = 'x'` legal —
    // and it still passes a mutual-assignability check against `Expected`,
    // which is why `Equals` is written the way it is above.
    expect(assertNotType<Equals<Readonly<Input>, Expected>>(false)).toBe(false);
    expect(assertType<Equals<DeepReadonly<Input>, Expected>>(true)).toBe(true);
  });

  it('makes arrays readonly all the way down', () => {
    type Input = { roles: string[]; rows: { id: string }[] };
    type Expected = {
      readonly roles: readonly string[];
      readonly rows: readonly { readonly id: string }[];
    };

    expect(assertType<Equals<DeepReadonly<Input>, Expected>>(true)).toBe(true);
  });

  it('preserves tuple arity instead of collapsing to an array of the union', () => {
    type Input = [string, { id: string }];
    type Expected = readonly [string, { readonly id: string }];

    // An explicit `T extends readonly (infer U)[]` branch would have produced
    // `readonly (string | { readonly id: string })[]` here, losing the arity and
    // the position-to-type correlation with it.
    expect(assertType<Equals<DeepReadonly<Input>, Expected>>(true)).toBe(true);
  });

  it('maps Map and Set to their readonly forms', () => {
    type Input = { byId: Map<string, { id: string }>; seen: Set<{ id: string }> };
    type Expected = {
      readonly byId: ReadonlyMap<string, { readonly id: string }>;
      readonly seen: ReadonlySet<{ readonly id: string }>;
    };

    // The only protection these two have: `Object.freeze` does not stop
    // `map.set(…)`, so removing the mutators from the type is the whole of it.
    expect(assertType<Equals<DeepReadonly<Input>, Expected>>(true)).toBe(true);
  });
});

describe('DeepReadonly — leaves', () => {
  it('leaves primitives alone', () => {
    expect(assertType<Equals<DeepReadonly<string>, string>>(true)).toBe(true);
    expect(assertType<Equals<DeepReadonly<number | null>, number | null>>(true)).toBe(true);
  });

  it('keeps a function callable', () => {
    type Fn = (input: string) => number;

    // A homomorphic mapped type keeps properties and drops call signatures, so
    // descending into a function turns it into `{}`.
    expect(assertType<Equals<DeepReadonly<Fn>, Fn>>(true)).toBe(true);
  });

  it('keeps Date, Buffer and friends as themselves', () => {
    // `readonly` on a `Date`'s methods would claim an immutability that
    // `setTime` disproves, and `deepFreeze` refuses to freeze these for the
    // same reason. A row's `created_at` is protected against replacement, not
    // against being edited in place.
    expect(assertType<Equals<DeepReadonly<Date>, Date>>(true)).toBe(true);
    expect(assertType<Equals<DeepReadonly<Uint8Array>, Uint8Array>>(true)).toBe(true);
    expect(assertType<Equals<DeepReadonly<RegExp>, RegExp>>(true)).toBe(true);
  });

  it('distributes over a union', () => {
    type Input = { a: { n: number } } | { b: { n: number } };
    type Expected =
      | { readonly a: { readonly n: number } }
      | { readonly b: { readonly n: number } };

    expect(assertType<Equals<DeepReadonly<Input>, Expected>>(true)).toBe(true);
  });
});
