export type {
  ConditionalDelete,
  ConditionalUpdate,
  Precondition,
} from '@/concurrency/concurrency.types';
export { ANY_VERSION } from '@/concurrency/concurrency.types';

export {
  PreconditionMalformedError,
  PreconditionRequiredError,
  VersionConflictError,
} from '@/concurrency/concurrency.errors';

export type { IfMatchResult } from '@/concurrency/etag';
export { ETAG_HEADER, formatETag, IF_MATCH_HEADER, parseIfMatch } from '@/concurrency/etag';

export type { WithPrecondition } from '@/concurrency/precondition';
export { requireIfMatch } from '@/concurrency/precondition';

export { sendWithETag } from '@/concurrency/respond';
