import type { Request } from 'express';
import { MAX_FIELD_LENGTH } from '@/sse/frame';

/**
 * Where the client's cursor comes in, and why there are two places.
 *
 * The header is the spec mechanism: `EventSource` stores the last `id` it
 * dispatched and sets `Last-Event-ID` on every reconnect, automatically, with
 * no application code involved. That covers the case the format was designed
 * for — a stream that drops and is re-established by the same `EventSource`
 * object.
 *
 * It does not cover the case that actually happens to a browser client, which
 * is a page reload. The new `EventSource` has no history, so the first request
 * carries no header, and `EventSource` cannot be given one — the constructor
 * accepts a URL and a `withCredentials` flag and nothing else. A client that
 * persisted its cursor across the reload therefore has exactly one way to
 * present it, and that is the query string.
 *
 * The header wins where both are present: it is the one the *browser* maintains
 * from what it actually dispatched, where the query parameter is whatever the
 * page last got round to persisting.
 */
export const LAST_EVENT_ID_HEADER = 'last-event-id';
export const LAST_EVENT_ID_QUERY_PARAM = 'lastEventId';

/**
 * A cursor is rejected here only for being unusable as a *string* — too long,
 * or carrying a character the wire format cannot survive. Whether it points
 * anywhere is `SseEventLog.since`'s question, and the answer to a cursor that
 * does not is a `reset` on an open stream rather than a 4xx: the request is
 * fine, and refusing it would take away the client's means of recovering.
 */
function usable(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_FIELD_LENGTH &&
    !value.includes('\u0000') &&
    !/[\r\n]/.test(value)
  );
}

/** The cursor this request is resuming from, or `undefined` for a fresh stream. */
export function readLastEventId(req: Request): string | undefined {
  const header = req.get(LAST_EVENT_ID_HEADER);
  if (header !== undefined && usable(header)) {
    return header;
  }

  // `req.query` values are `string | string[] | ParsedQs | ParsedQs[]`: a
  // repeated parameter is an array and `?lastEventId[x]=1` is an object, so the
  // narrowing is not ceremony. Either shape means the caller sent something
  // this endpoint does not accept, and both fall through to a fresh stream.
  const fromQuery = req.query[LAST_EVENT_ID_QUERY_PARAM];
  if (typeof fromQuery === 'string' && usable(fromQuery)) {
    return fromQuery;
  }

  return undefined;
}
