import type { Unsubscribe } from '@/events/event-bus';
import type { DomainEventBus } from '@/events/domain-events';
import type { AuditLogSubscriberOptions } from '@/events/subscribers/audit-log.subscriber';
import { registerAuditLogSubscriber } from '@/events/subscribers/audit-log.subscriber';
import type { SessionRevocationSubscriberOptions } from '@/events/subscribers/session-revocation.subscriber';
import { registerSessionRevocationSubscriber } from '@/events/subscribers/session-revocation.subscriber';

export type { AuditEntry, AuditSink } from '@/events/subscribers/audit-log.subscriber';
export {
  consoleAuditSink,
  registerAuditLogSubscriber,
} from '@/events/subscribers/audit-log.subscriber';
export { registerSessionRevocationSubscriber } from '@/events/subscribers/session-revocation.subscriber';

export interface DomainSubscriberOptions {
  audit?: AuditLogSubscriberOptions;
  sessionRevocation?: SessionRevocationSubscriberOptions;
}

/**
 * Attaches every subscriber this service ships with.
 *
 * Called once from the composition root, which is the only place that should
 * know the full set — a module that subscribed on its own import would be
 * impossible to deploy without.
 *
 * The returned function detaches all of them, so a test can install its own
 * subscribers on the shared bus and put it back afterwards.
 */
export function registerDomainSubscribers(
  bus: DomainEventBus,
  options: DomainSubscriberOptions = {},
): Unsubscribe {
  const unsubscribes: Unsubscribe[] = [
    registerAuditLogSubscriber(bus, options.audit),
    registerSessionRevocationSubscriber(bus, options.sessionRevocation),
  ];

  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}
