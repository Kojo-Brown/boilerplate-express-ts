/**
 * Types that `DeepReadonly` stops at rather than descending into.
 *
 * Two different reasons live in this list, and both are worth separating:
 *
 * - **Nothing to descend into.** A primitive, a function, a `RegExp`. Mapping
 *   their properties produces noise and, for functions, destroys the call
 *   signature — a homomorphic mapped type keeps properties, not signatures, so
 *   `DeepReadonly<() => void>` would become `{}` and stop being callable.
 * - **Descending would lie.** `Date`, `ArrayBuffer` and views over one keep
 *   their state in internal slots, not in properties. Marking every property
 *   `readonly` says "this cannot change" about a value where `setTime` and
 *   `buffer[0] = 1` still work. Leaving them alone is the honest answer, and
 *   `deepFreeze` refuses to freeze them for the same reason.
 *
 * `Error` and `Promise` are here as a third, smaller case: they are objects a
 * value happens to *carry*, not data it is made of, and a `readonly stack` is a
 * problem rather than a guarantee — the stack is written lazily on first read.
 */
type ImmutableLeaf =
  | null
  | undefined
  | string
  | number
  | boolean
  | symbol
  | bigint
  | ((...args: never[]) => unknown)
  | Date
  | RegExp
  | Error
  | Promise<unknown>
  | ArrayBuffer
  | ArrayBufferView;

/**
 * `Readonly`, applied all the way down.
 *
 * The shallow one stops at the first property: `Readonly<{ user: { email:
 * string } }>` forbids replacing `user` and permits `value.user.email = 'x'`,
 * which is the mutation that actually happens — nobody reassigns the root of a
 * structure they were handed, they reach into it.
 *
 * Arrays and tuples are covered by the object branch rather than a branch of
 * their own. A homomorphic mapped type over an array produces an array, over a
 * tuple produces a tuple of the same arity, and the `readonly` modifier turns
 * both into their `readonly` form — so `DeepReadonly<[string, User[]]>` stays a
 * two-element tuple instead of collapsing into a union-element array, which is
 * what an explicit `T extends readonly (infer U)[]` branch would have done.
 *
 * `Map` and `Set` are the one place where this type is the *only* protection
 * available: `Object.freeze` cannot stop `map.set(…)`, because the entries are
 * internal slots. Mapping them to `ReadonlyMap`/`ReadonlySet` removes the
 * mutators at the type level, which is the layer that holds for them.
 */
export type DeepReadonly<T> = T extends ImmutableLeaf
  ? T
  : T extends ReadonlyMap<infer K, infer V>
    ? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>>
    : T extends ReadonlySet<infer U>
      ? ReadonlySet<DeepReadonly<U>>
      : T extends object
        ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
        : T;
