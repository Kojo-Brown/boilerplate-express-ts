import { getAppRedactor } from '@/logging/app-redactor';
import type { DomainEvent, SubscriberView, Unsubscribe } from '@/events/event-bus';
import type { DomainEventBus, DomainEventName, DomainEventPayloads } from '@/events/domain-events';

/**
 * One audit line. Flat and already serialisable, because the sink's job is to
 * write it, not to interpret it.
 */
export interface AuditEntry {
  /** The event's id, so a duplicated line is recognisable as one delivery. */
  eventId: string;
  eventName: DomainEventName;
  occurredAt: string;
  correlationId: string | null;
  /** The principal that caused it, when the event knows. */
  actorId: string | null;
  /** What it happened to — a user id here, other resources later. */
  subject: string;
  attributes: Record<string, unknown>;
}

/**
 * Where audit lines go. An interface because the destination is a deployment
 * concern: stdout behind a log shipper today, an append-only table or a SIEM
 * later, without the subscriber changing.
 */
export interface AuditSink {
  record(entry: AuditEntry): void | Promise<void>;
}

/**
 * Default sink: one redacted JSON object per line on stdout.
 *
 * Deliberately not the request logger's format. Morgan's line describes an HTTP
 * exchange and is sampled and rotated accordingly; this describes a
 * security-relevant fact and is the sort of thing that gets kept for years.
 * They share a `correlationId` so the two can be joined, and nothing else.
 *
 * "Kept for years" is also why the redactor is here and not at the call sites.
 * Retention is what turns a field that was fine to write into a liability: the
 * `user.created` descriptor above records the address the account was opened
 * with, which is useful for about a week and is a subject-access request for
 * the rest of the decade. `attributes.email` therefore reaches stdout as
 * `[redacted]`, and a deployment that genuinely needs the address against the
 * audit trail should join on `subject` into the encrypted store
 * (`src/users/user-pii.repository.ts`), where it is covered by key rotation and
 * by deletion, rather than copy it into a log file that is covered by neither.
 *
 * It wraps the *sink* rather than `registerAuditLogSubscriber` because the sink
 * is the boundary: a deployment that swaps in a SIEM sink is sending the entry
 * somewhere with its own controls, and it should decide for itself. What must
 * not happen is stdout getting the raw entry because nobody remembered.
 */
export const consoleAuditSink: AuditSink = {
  record(entry: AuditEntry): void {
    console.log(JSON.stringify(getAppRedactor()({ type: 'audit', ...entry })));
  },
};

/**
 * What a given event contributes to its audit line, or `null` to skip it.
 *
 * The payload is the subscriber's read-only view, matching what the bus hands
 * over. Spelling it out here rather than leaving it as `DomainEventPayloads[K]`
 * matters because TypeScript ignores `readonly` property modifiers when it
 * checks assignability: a handler annotated with the mutable payload type is
 * accepted by `bus.on` without complaint, and then a descriptor that edits its
 * payload compiles. The annotation is the thing that closes that, not the bus.
 */
type AuditDescriptor<K extends DomainEventName> = (
  payload: SubscriberView<DomainEventPayloads[K]>,
) => Pick<AuditEntry, 'subject' | 'actorId'> & { attributes?: Record<string, unknown> };

/**
 * The audit table, exhaustive over `DomainEventName` by construction.
 *
 * This is the point of the mapped type: adding an event to
 * `DomainEventPayloads` fails to compile until someone decides what it means
 * for the audit trail. An audit log that silently omits the event nobody
 * remembered to wire up is worse than no audit log, because it is trusted.
 *
 * Every event today is security-relevant and so every descriptor produces a
 * line. The type still earns its place on the next one that is not — that entry
 * has to be written out and justified rather than forgotten.
 */
const AUDIT_DESCRIPTORS: { [K in DomainEventName]: AuditDescriptor<K> } = {
  'user.created': (payload) => ({
    subject: payload.userId,
    actorId: payload.actorId,
    attributes: { email: payload.email, roles: [...payload.roles] },
  }),

  'user.updated': (payload) => ({
    subject: payload.userId,
    actorId: payload.actorId,
    attributes: { changedFields: [...payload.changedFields] },
  }),

  'user.deleted': (payload) => ({
    subject: payload.userId,
    actorId: payload.actorId,
    attributes: {},
  }),

  // The authenticated user is both actor and subject: nobody else can perform
  // a login on their behalf, which is exactly what makes a mismatch elsewhere
  // in this table worth reading.
  'auth.login.succeeded': (payload) => ({
    subject: payload.userId,
    actorId: payload.userId,
    attributes: { strategy: payload.strategy },
  }),

  'auth.session.revoked': (payload) => ({
    subject: payload.userId,
    actorId: payload.userId,
    attributes: { scope: payload.scope },
  }),

  // `actorId` is the user and not `null`, even though the whole point of this
  // event is that it may not have been them: the family is theirs, the token
  // was issued to them, and an audit line that disclaimed the actor would be
  // claiming to know something the detection specifically cannot. Who actually
  // presented it is what the surrounding request log is for.
  'auth.refresh.reused': (payload) => ({
    subject: payload.userId,
    actorId: payload.userId,
    attributes: { familyId: payload.familyId, revokedCount: payload.revokedCount },
  }),
};

export interface AuditLogSubscriberOptions {
  sink?: AuditSink;
}

/**
 * Writes an audit line for every domain event.
 *
 * Registered by the composition root, and safe to leave out of a deployment
 * that ships audit elsewhere — no publisher can tell whether it is attached,
 * which is the property the bus exists to provide.
 */
export function registerAuditLogSubscriber(
  bus: DomainEventBus,
  options: AuditLogSubscriberOptions = {},
): Unsubscribe {
  const { sink = consoleAuditSink } = options;

  const unsubscribes = (Object.keys(AUDIT_DESCRIPTORS) as DomainEventName[]).map((name) => {
    // Indexing the table with a *union* key yields a union of descriptors, and
    // a union of functions accepts the intersection of their parameters —
    // uncallable. The record is `{ [K in DomainEventName]: AuditDescriptor<K> }`
    // by construction, so this key and this descriptor do belong together; the
    // compiler simply cannot carry that correlation through the loop. Widening
    // to the union payload is the narrowest way to say so, and it is checked in
    // the sense that matters: a descriptor only ever sees its own event.
    const describe = AUDIT_DESCRIPTORS[name] as AuditDescriptor<DomainEventName>;

    return bus.on(
      name,
      async (
        event: DomainEvent<DomainEventName, SubscriberView<DomainEventPayloads[DomainEventName]>>,
      ) => {
        const { subject, actorId, attributes } = describe(event.payload);

        await sink.record({
          eventId: event.id,
          eventName: event.name,
          occurredAt: event.occurredAt.toISOString(),
          correlationId: event.correlationId,
          actorId,
          subject,
          attributes: attributes ?? {},
        });
      },
    );
  });

  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}
