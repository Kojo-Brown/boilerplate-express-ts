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
