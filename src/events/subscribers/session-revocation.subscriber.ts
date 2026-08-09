import type { RefreshTokenStore } from '@/auth/auth.types';
import { tokenStore } from '@/auth/token-store';
import type { Unsubscribe } from '@/events/event-bus';
import type { DomainEventBus } from '@/events/domain-events';

export interface SessionRevocationSubscriberOptions {
  tokens?: RefreshTokenStore;
}

/**
 * Kills a deleted user's refresh tokens.
 *
 * This is the subscriber that justifies the bus. Deleting the row does not end
 * the session: an access token stays valid until it expires, and the refresh
 * token outlives it by a week, so without this a deleted account can keep
 * minting credentials for as long as `JWT_REFRESH_EXPIRES_IN`. Someone has to
 * revoke them — the question is who.
 *
 * Not the users module: `DELETE /v1/users/:id` would have to import the auth
 * module's token store, and every later consequence of deletion (uploads
 * purged, sessions cleared, a webhook fired) would accrete onto the same
 * handler until the controller was the union of every module's teardown. It
 * publishes a fact and stops.
 *
 * The honest limit: this is best-effort, in-process, at-most-once. A failure
 * here is reported by the bus and no more — the delete has already answered
 * 204, so a store that is down leaves live refresh tokens behind and only the
 * log says so. Making revocation *guaranteed* means writing the intent down in
 * the same transaction as the delete and having a relay drain it, which is the
 * transactional outbox in Phase 7. Until that exists this is a real, narrow
 * exposure window, and it is smaller than the one it replaces (forever).
 */
export function registerSessionRevocationSubscriber(
  bus: DomainEventBus,
  options: SessionRevocationSubscriberOptions = {},
): Unsubscribe {
  const { tokens = tokenStore } = options;

  return bus.on('user.deleted', async function revokeSessionsForDeletedUser(event) {
    await tokens.removeAllForUser(event.payload.userId);
  });
}
