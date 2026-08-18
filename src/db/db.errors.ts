import { DatabaseError } from 'pg';
import type { ErrorTranslator } from '@/lib/error-translators';

/**
 * Postgres integrity violations that have an unambiguous HTTP meaning. Anything
 * absent from this table is a server-side fault (bad SQL, missing table, dead
 * connection) and is left to fall through to the 500 handler.
 *
 * @see https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
const SQLSTATE_RESPONSES: Record<string, { statusCode: number; code: string; message: string }> = {
  // unique_violation — the row already exists (e.g. duplicate users.email).
  '23505': {
    statusCode: 409,
    code: 'UNIQUE_VIOLATION',
    message: 'A record with those values already exists',
  },
  // foreign_key_violation — the referenced row is missing or still referenced.
  '23503': {
    statusCode: 409,
    code: 'FOREIGN_KEY_VIOLATION',
    message: 'A referenced record is missing or still in use',
  },
  // not_null_violation — a required column was omitted by the caller.
  '23502': {
    statusCode: 422,
    code: 'NOT_NULL_VIOLATION',
    message: 'A required field was missing',
  },
  // check_violation — a column constraint rejected the value.
  '23514': {
    statusCode: 422,
    code: 'CHECK_VIOLATION',
    message: 'A field failed a database constraint',
  },
  // invalid_text_representation — e.g. a malformed uuid in a path parameter.
  '22P02': {
    statusCode: 400,
    code: 'INVALID_INPUT_SYNTAX',
    message: 'A field was not in the expected format',
  },
  // The three contention failures. All are 409 rather than 500 because nothing
  // is broken: the request lost a race, and repeating it is likely to succeed.
  // A 500 says the opposite, and a client that believes it stops retrying.
  //
  // These reach a response only after `withRetryableTransaction` has given up
  // (or was never used), so by the time one is rendered the retry budget is
  // spent and the next backoff belongs to the client — which is what a 409
  // asks for and a 503 would not, since the service is up and serving everyone
  // who is not contending for this row.
  //
  // deadlock_detected — two transactions waited on each other; this one lost.
  '40P01': {
    statusCode: 409,
    code: 'WRITE_CONFLICT',
    message: 'The request conflicted with a concurrent write; please retry',
  },
  // serialization_failure — the transaction could not be serialised.
  '40001': {
    statusCode: 409,
    code: 'WRITE_CONFLICT',
    message: 'The request conflicted with a concurrent write; please retry',
  },
  // lock_not_available — `NOWAIT`, or `lock_timeout` expiring while waiting.
  // Distinct from the two above on purpose: those mean "you were rolled back",
  // this one means "somebody is still holding it", and a client that
  // distinguishes them can back off differently.
  '55P03': {
    statusCode: 409,
    code: 'RESOURCE_LOCKED',
    message: 'The record is being modified by another request; please retry',
  },
};

/**
 * Turns integrity violations into the 4xx they actually are. Without this a
 * duplicate email surfaces as a 500, which reads as "the server is broken"
 * rather than "your request conflicts".
 *
 * The driver's message is not forwarded: it names constraints, columns and
 * sometimes the offending value, none of which belongs in a client response.
 */
export const postgresErrorTranslator: ErrorTranslator = (err) => {
  if (!(err instanceof DatabaseError)) return null;
  const response = err.code !== undefined ? SQLSTATE_RESPONSES[err.code] : undefined;
  return response ?? null;
};
