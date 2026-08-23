export type { DeepReadonly } from '@/lib/immutable/deep-readonly';

export { deepFreeze } from '@/lib/immutable/freeze';

// Not re-exported by `@/config/env`'s import path on purpose: this module reads
// `env`, and `env.ts` freezes itself with `deepFreeze`. Importing the barrel
// from there would close that into a cycle, so `env.ts` imports
// `@/lib/immutable/freeze` directly.
export { FREEZE_IN_DEV, freezeInDev } from '@/lib/immutable/dev-freeze';

export { omit, patch, pick } from '@/lib/immutable/update';
