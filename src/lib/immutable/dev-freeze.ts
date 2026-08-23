import { env } from '@/config/env';
import { deepFreeze } from '@/lib/immutable/freeze';

/**
 * Whether `freezeInDev` actually freezes.
 *
 * Read once, at module load, into a constant: the production path has to be a
 * function that returns its argument and nothing else, and a `process.env`
 * lookup per cached response is not that. It reads the validated `env` rather
 * than `process.env` directly so an unrecognised `NODE_ENV` has already failed
 * the process at boot instead of quietly selecting the checked path here.
 *
 * `!== 'production'` rather than `=== 'development'` on purpose. `test` is the
 * environment where this earns its keep: a suite is the one place a mutation is
 * reproducible, deterministic and attached to the change that caused it.
 */
export const FREEZE_IN_DEV: boolean = env.NODE_ENV !== 'production';

/**
 * A dev-and-test-only assertion that nobody writes to this value.
 *
 * Freezing costs a walk of the structure, which is fine at boot and not fine on
 * every cached response, so production skips it. That makes this a *check*
 * rather than a guarantee — the invariant is only enforced where somebody is
 * watching. The trade is the usual one for an assertion: it is worth having
 * because the failure it catches is silent otherwise, and the mutation it would
 * have caught in production is a bug that dev and CI now fail on first.
 *
 * The return type is `T`, unchanged, and that is deliberate. Widening it to
 * `DeepReadonly<T>` would make a decorator's static contract depend on
 * `NODE_ENV`, and would push a caching or fan-out detail into the signature of
 * every operation that passes through one. Where the type should carry the
 * guarantee, the value is not a candidate for freezing "in dev" at all — it is
 * immutable everywhere, and `deepFreeze` says so.
 */
export function freezeInDev<T>(value: T): T {
  if (FREEZE_IN_DEV) deepFreeze(value);
  return value;
}
