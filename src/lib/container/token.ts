/**
 * The phantom field that carries a token's resolved type.
 *
 * `declare const` on a `unique symbol` means the property exists only in the
 * type system — nothing is emitted, and no token object carries it at runtime.
 * Typing it as a function from `T` to `T` makes `InjectionToken` *invariant* in
 * `T`: `InjectionToken<AdminUser>` is neither assignable to nor from
 * `InjectionToken<User>`. A covariant phantom (`readonly _type?: T`) would let
 * `registerValue<User>(adminUserToken, someUser)` typecheck, registering the
 * wider value under the narrower token — the one substitution a container must
 * never make silently.
 */
declare const TOKEN_TYPE: unique symbol;

/**
 * An opaque, type-carrying key.
 *
 * Identity is the object, not the description: two tokens created with the same
 * description are different keys. That is deliberate — descriptions exist for
 * error messages, and making them significant would turn a copy-pasted string
 * into a silently shared registration.
 */
export interface InjectionToken<T> {
  readonly description: string;
  readonly [TOKEN_TYPE]?: (value: T) => T;
}

/**
 * A token with its type argument erased.
 *
 * Invariance is worth having at the API surface and unusable inside the
 * implementation: `InjectionToken<T>` is assignable to no other
 * `InjectionToken`, so a `Map<InjectionToken<unknown>, …>` could not be keyed
 * by one. Every token structurally satisfies this, which is all the internals —
 * map keys, resolution paths, error messages — actually need.
 */
export type AnyInjectionToken = { readonly description: string };

/**
 * Mints a token for `T`.
 *
 * The type argument is not optional in practice: `createToken('UserRepository')`
 * infers `unknown` and every resolve of it needs a cast. Always write
 * `createToken<UserRepository>('UserRepository')`.
 *
 * @param description Shown in resolution errors and dependency paths. Name the
 * thing being resolved, not the variable holding the token.
 */
export function createToken<T>(description: string): InjectionToken<T> {
  return { description };
}

/** Renders a resolution path (`A → B → C`) for error messages. */
export function formatPath(path: readonly AnyInjectionToken[]): string {
  return path.map((token) => token.description).join(' → ');
}
