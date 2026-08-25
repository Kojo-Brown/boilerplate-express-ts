import type { AuthStrategyName } from '@/auth/strategies';
import type { EventBus } from '@/events/event-bus';
import { createEventBus } from '@/events/event-bus';

/**
 * Every domain event this service publishes, and what it carries.
 *
 * Two rules hold for every payload here, and both are load-bearing:
 *
 * **Facts, not commands.** `user.deleted` states what happened; it is not
 * `revokeSessions`. A publisher that names the consequence has only moved the
 * coupling into the event name — the users module would still be the thing
 * deciding that sessions must die, just at a distance and without a type to
 * check it. Naming the fact is what lets a subscriber appear or disappear
 * without the publisher changing.
 *
 * **Identifiers, not credentials.** Payloads reach subscribers whose entire job
 * is to write them somewhere durable — an audit log, later a message broker —
 * so a token, password hash, or magic-link secret placed here is a secret
 * published to every current and future sink. `auth.login.succeeded` therefore
 * carries the user id and the strategy that authenticated them, and nothing the
 * caller could replay.
 *
 * A `type` rather than an `interface` because `EventBus` needs the key set to
 * be final — see `EventPayloadMap`.
 */
export type DomainEventPayloads = {
  'user.created': {
    userId: string;
    email: string;
    roles: readonly string[];
    /** The principal that performed it, or `null` when it was not a request. */
    actorId: string | null;
  };

  'user.updated': {
    userId: string;
    /**
     * Which fields the update touched — names only, never values. A role change
     * is a privilege change, and this is what makes it visible in the audit log
     * without copying the new row into it.
     */
    changedFields: readonly string[];
    actorId: string | null;
  };

  'user.deleted': {
    userId: string;
    actorId: string | null;
  };

  'auth.login.succeeded': {
    userId: string;
    strategy: AuthStrategyName;
  };

  'auth.session.revoked': {
    userId: string;
    /** `all` is a logout-everywhere; `single` retires one refresh token. */
    scope: 'single' | 'all';
  };
};

export type DomainEventName = keyof DomainEventPayloads & string;

/**
 * The same names again, as values.
 *
 * A type cannot be consulted at runtime, and the outbox needs to: a claimed row
 * carries an `event_name` that some other — possibly older, possibly newer —
 * deployment wrote, so `DomainEventName` describes what *this* build knows
 * rather than what is in the table. This is the list that decides whether a
 * stored name is one of them.
 *
 * Kept exhaustive by the assertion below rather than by care.
 */
export const DOMAIN_EVENT_NAMES = [
  'user.created',
  'user.updated',
  'user.deleted',
  'auth.login.succeeded',
  'auth.session.revoked',
] as const satisfies readonly DomainEventName[];

/**
 * A compile error the moment an event is added to `DomainEventPayloads` without
 * being listed above.
 *
 * `satisfies` alone only checks that every listed name is real; it says nothing
 * about the ones that were forgotten, and a forgotten name is the failure that
 * matters here — its messages would be dead-lettered as unrecognised by a build
 * that in fact has subscribers for them.
 */
export type MissingDomainEventNames = Exclude<
  DomainEventName,
  (typeof DOMAIN_EVENT_NAMES)[number]
> extends never
  ? true
  : ['DOMAIN_EVENT_NAMES is missing', Exclude<DomainEventName, (typeof DOMAIN_EVENT_NAMES)[number]>];

const _allDomainEventNamesListed: MissingDomainEventNames = true;
void _allDomainEventNamesListed;

const DOMAIN_EVENT_NAME_SET: ReadonlySet<string> = new Set(DOMAIN_EVENT_NAMES);

/** Whether a name read back out of storage is one this build can deliver. */
export function isDomainEventName(name: string): name is DomainEventName {
  return DOMAIN_EVENT_NAME_SET.has(name);
}

export type DomainEventBus = EventBus<DomainEventPayloads>;

/**
 * Process-wide bus. Subscribers are attached to it in the composition root
 * (`app.ts`), never at the point of use — a module that subscribes on import
 * has made itself impossible to leave out.
 *
 * Publishers hold this directly; the auth service takes it as a dependency
 * instead, because its tests need to assert on what was published.
 */
export const domainEventBus: DomainEventBus = createEventBus<DomainEventPayloads>();
