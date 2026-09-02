import { z } from 'zod';
import type { WsConnection } from '@/ws/connection';

/**
 * The message protocol spoken over `/v1/ws`, and the place a real one replaces it.
 *
 * What is here is deliberately small — a liveness round trip, an echo, and a
 * "who am I" that proves the handshake's principal survived onto the socket —
 * because the item this module exists for is the *transport*: authenticated,
 * rate-limited, heartbeat-managed, backpressure-aware. Those properties are
 * identical whether the frames underneath carry chat messages or telemetry, and
 * a boilerplate that shipped an opinionated chat protocol would be asking every
 * consumer to delete it first.
 *
 * The two decisions worth keeping when it is replaced:
 *
 * **Frames are validated, and a bad one is an error frame rather than a close.**
 * The REST side validates at the edge with Zod and so does this. But a
 * malformed request body ends one request, whereas closing a socket over one
 * bad frame throws away every subscription on it and sends the client into a
 * reconnect loop it cannot debug. Malformed input is per-message; the closes in
 * `WS_CLOSE` are for conditions that describe the *connection*.
 *
 * **The reply is correlated.** Nothing about a socket guarantees that the next
 * frame you receive answers the last one you sent — that is the property
 * request/response gives you for free and the one people most often assume
 * still holds. `id` is echoed on every reply so a client can match them; a
 * client that ignores it and assumes ordering will work perfectly until the
 * first server-initiated push arrives in the middle.
 */

/** Frames the client may send. */
const clientFrameSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ping'),
    id: z.string().max(64).optional(),
  }),
  z.object({
    type: z.literal('echo'),
    id: z.string().max(64).optional(),
    // `unknown` rather than a shape: the point of the echo is that it returns
    // what it was given, and constraining it here would be constraining a
    // diagnostic. The *size* is bounded, by the rate limiter's
    // `maxMessageBytes`, which is the bound that matters.
    payload: z.unknown(),
  }),
  z.object({
    type: z.literal('whoami'),
    id: z.string().max(64).optional(),
  }),
]);

export type ClientFrame = z.infer<typeof clientFrameSchema>;

export type ServerFrame =
  | { readonly type: 'pong'; readonly id?: string }
  | { readonly type: 'echo'; readonly id?: string; readonly payload: unknown }
  | { readonly type: 'whoami'; readonly id?: string; readonly userId: string; readonly roles: string[] }
  | { readonly type: 'error'; readonly id?: string; readonly code: string; readonly message: string };

/**
 * Parses and dispatches one text frame.
 *
 * Synchronous and total: every path ends in exactly one frame sent back, which
 * is what makes a client's "I sent something and heard nothing" a bug report
 * rather than an ambiguity.
 */
export function handleClientFrame(message: string, connection: WsConnection): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    connection.send({
      type: 'error',
      code: 'MALFORMED_FRAME',
      message: 'Frame is not valid JSON',
    } satisfies ServerFrame);
    return;
  }

  const result = clientFrameSchema.safeParse(parsed);
  if (!result.success) {
    // The id is read off the raw value rather than the parsed one, because the
    // frame that failed validation is exactly the one whose reply most needs
    // correlating — a client with three requests in flight otherwise cannot
    // tell which of them was rejected.
    const id = readFrameId(parsed);
    connection.send({
      type: 'error',
      ...(id !== undefined ? { id } : {}),
      code: 'INVALID_FRAME',
      message: result.error.issues[0]?.message ?? 'Frame did not match any known message type',
    } satisfies ServerFrame);
    return;
  }

  const frame = result.data;
  const id = frame.id;

  switch (frame.type) {
    case 'ping':
      connection.send({ type: 'pong', ...(id !== undefined ? { id } : {}) } satisfies ServerFrame);
      return;

    case 'echo':
      connection.send({
        type: 'echo',
        ...(id !== undefined ? { id } : {}),
        payload: frame.payload,
      } satisfies ServerFrame);
      return;

    case 'whoami':
      connection.send({
        type: 'whoami',
        ...(id !== undefined ? { id } : {}),
        userId: connection.principal.userId,
        roles: connection.principal.roles,
      } satisfies ServerFrame);
      return;
  }
}

/** Best-effort `id` from a frame that failed validation. */
function readFrameId(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' && id.length <= 64 ? id : undefined;
}
