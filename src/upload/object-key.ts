import { randomUUID } from 'node:crypto';

/** The single path segment every object this service writes lives under. */
const KEY_PREFIX = 'uploads/';

/**
 * Derives the object key an upload will be stored under.
 *
 * The name a client sends contributes its extension and nothing else: the
 * identifier is server-generated, so no request can pick its own path, collide
 * with an existing object, or smuggle `../` into a key.
 *
 * Shared by every storage adapter — two backends that named objects
 * differently would make keys stop being portable the moment the driver
 * changed.
 */
export function buildObjectKey(originalName: string): string {
  return `${KEY_PREFIX}${randomUUID()}${extensionOf(originalName)}`;
}

/**
 * The suffix of `originalName` that is safe to carry into a key, or nothing.
 *
 * `originalName.slice(originalName.lastIndexOf('.'))` is what this used to be
 * and it does not hold: the last dot in `../../etc/passwd` is the one in `..`,
 * so the "extension" was `./etc/passwd` and the key it built was
 * `uploads/<uuid>./etc/passwd`. Every segment after the UUID came straight from
 * a client-supplied `fileName` — a string this service otherwise never lets
 * near a key, which is the entire premise of the function. On S3 that escapes
 * the `uploads/` prefix the bucket policy is written against; on any
 * filesystem-backed driver it is a plain traversal. Nothing was reachable
 * through it — a key like that satisfies no `OBJECT_ID_PATTERN` and so cannot
 * be downloaded — but it was writable, which is worse.
 *
 * So the extension is matched rather than sliced, against the same shape
 * `OBJECT_ID_PATTERN` accepts. That is what makes "every key this module builds
 * is a key it can parse back" true by construction rather than by inspection,
 * and it is asserted both ways in the tests.
 */
function extensionOf(originalName: string): string {
  const match = /\.[A-Za-z0-9]{1,10}$/.exec(originalName);
  return match?.[0] ?? '';
}

/**
 * Exactly what `buildObjectKey` puts after the prefix: a UUID and at most one
 * short alphanumeric extension.
 *
 * Written as an anchored whitelist because this is the value a *client* supplies
 * on the download route, and a key is a path. The rejected inputs are the point:
 * `../../etc/passwd`, a second `uploads/` segment, a key belonging to another
 * prefix in the same bucket. Nothing here needs normalising or decoding first,
 * because nothing that would need it is accepted.
 */
export const OBJECT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[A-Za-z0-9]{1,10})?$/;

/**
 * The storage key an object id names.
 *
 * The route takes the id rather than the key so that the prefix is this
 * module's to choose and never the client's to send — the same reason
 * `buildObjectKey` ignores everything but the extension of the name it is
 * given. Callers must have validated `objectId` against `OBJECT_ID_PATTERN`
 * first; the assertion is a backstop for a caller that forgot, not the
 * validation itself, which belongs at the edge where it can be a 422.
 */
export function objectKeyFromId(objectId: string): string {
  if (!OBJECT_ID_PATTERN.test(objectId)) {
    throw new RangeError(`objectKeyFromId: ${objectId} is not a well-formed object id`);
  }
  return `${KEY_PREFIX}${objectId}`;
}
