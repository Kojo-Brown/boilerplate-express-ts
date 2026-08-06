import { randomUUID } from 'node:crypto';

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
  const lastDot = originalName.lastIndexOf('.');
  const ext = lastDot !== -1 ? originalName.slice(lastDot) : '';
  return `uploads/${randomUUID()}${ext}`;
}
