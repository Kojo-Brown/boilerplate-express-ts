import { z } from 'zod';
import { MalformedStreamEntryError } from '@/redis/redis.errors';
import type { StreamEntry } from '@/redis/stream.types';

/**
 * The wire shape of an event on a stream, and the encoder/decoder pair for it.
 *
 * The shape is not invented here: it is `toEnvelope`'s, the one the outbox
 * already produces for "a dispatcher writing to something other than the bus".
 * That is what makes the id a consumer deduplicates on the *same* id whether an
 * event reached it through the in-process bus or through Redis — a redelivery
 * is only recognisable if identity survives the transport.
 *
 * ## Why the payload is one JSON field rather than a field per key
 *
 * A stream entry is already a map, so spreading the payload across fields looks
 * like the native thing to do. It loses types: every stream field is a string,
 * so `count: 3` comes back `"3"` and `active: false` comes back `"false"`,
 * which is truthy. Recovering the original would need a schema per event on the
 * consumer — for payloads that, per `JsonSafe`, are already defined as
 * whatever survives a JSON round trip. One JSON field costs a parse and keeps
 * numbers numbers.
 *
 * The metadata stays in its own fields for the opposite reason: an operator
 * running `XRANGE` during an incident can read the name and the timestamp of
 * every entry without decoding anything, and `redis-cli` output stays legible.
 */

/** The metadata field names, exported because `XADD`-side tests assert on them. */
export const ENVELOPE_FIELDS = {
  id: 'id',
  name: 'name',
  occurredAt: 'occurredAt',
  correlationId: 'correlationId',
  payload: 'data',
} as const;

export interface StreamEventEnvelope {
  /** The publisher's id for the event — the outbox row's primary key. */
  readonly id: string;
  readonly name: string;
  /** When the fact happened, not when it was published. */
  readonly occurredAt: Date;
  readonly correlationId: string | null;
  /**
   * Whatever the producer wrote, and `unknown` for the same reason the outbox's
   * is: it was serialised by a possibly older, possibly newer deployment, and
   * no check short of a schema per event would establish more about it than the
   * name does. The name is checked at the point of use; this is not.
   */
  readonly payload: unknown;
}

/**
 * The metadata as it must appear on the wire.
 *
 * `min(1)` on the id and name because a producer that writes an empty string is
 * indistinguishable on the wire from one that wrote nothing, and an event with
 * no name cannot be routed. `datetime()` on the timestamp so a consumer's
 * `occurredAt.getTime()` cannot be `NaN` — the failure that shape produces
 * lands wherever the date is *used*, which is a subscriber, hours later.
 */
const envelopeFieldsSchema = z.object({
  [ENVELOPE_FIELDS.id]: z.string().min(1),
  [ENVELOPE_FIELDS.name]: z.string().min(1),
  [ENVELOPE_FIELDS.occurredAt]: z.string().datetime({ offset: true }),
  [ENVELOPE_FIELDS.correlationId]: z.string().min(1).optional(),
  [ENVELOPE_FIELDS.payload]: z.string(),
});

/**
 * An envelope to the fields of an `XADD`.
 *
 * `correlationId` is *omitted* when null rather than written as an empty
 * string. Redis has no null: an empty value would come back as `''`, and the
 * decoder would have to decide whether that means "no correlation id" or "a
 * correlation id that is the empty string". Absence has no such ambiguity, and
 * it is also what makes the schema above able to say `.optional()` and mean it.
 */
export function encodeEnvelope(envelope: StreamEventEnvelope): Record<string, string> {
  const fields: Record<string, string> = {
    [ENVELOPE_FIELDS.id]: envelope.id,
    [ENVELOPE_FIELDS.name]: envelope.name,
    [ENVELOPE_FIELDS.occurredAt]: envelope.occurredAt.toISOString(),
    [ENVELOPE_FIELDS.payload]: JSON.stringify(envelope.payload ?? null),
  };

  if (envelope.correlationId !== null) {
    fields[ENVELOPE_FIELDS.correlationId] = envelope.correlationId;
  }

  return fields;
}

/**
 * A stream entry back to an envelope, or a throw.
 *
 * Throwing `MalformedStreamEntryError` is a routing decision as much as an
 * error: the worker parks what this rejects instead of retrying it, because
 * nothing about a second attempt at `JSON.parse` on the same bytes will go
 * differently. Every *other* failure in the worker is retried. This is the one
 * place that distinction is made, so it is made on a type rather than on a
 * message.
 */
export function decodeEnvelope(entry: StreamEntry): StreamEventEnvelope {
  const parsed = envelopeFieldsSchema.safeParse(entry.fields);

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new MalformedStreamEntryError(entry.id, detail);
  }

  const fields = parsed.data;

  let payload: unknown;
  try {
    payload = JSON.parse(fields[ENVELOPE_FIELDS.payload]);
  } catch (error) {
    throw new MalformedStreamEntryError(
      entry.id,
      `field "${ENVELOPE_FIELDS.payload}" is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    id: fields[ENVELOPE_FIELDS.id],
    name: fields[ENVELOPE_FIELDS.name],
    occurredAt: new Date(fields[ENVELOPE_FIELDS.occurredAt]),
    correlationId: fields[ENVELOPE_FIELDS.correlationId] ?? null,
    payload,
  };
}
