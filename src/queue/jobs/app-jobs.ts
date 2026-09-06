/**
 * Every job this service queues, and what it carries.
 *
 * The rules are the ones `DomainEventPayloads` states, plus one this map has
 * and that one does not.
 *
 * **Commands, not facts.** This is the opposite of the event bus, and
 * deliberately: `auth.magic-link.deliver` names work somebody has to do. An
 * event says what happened and lets zero or many subscribers care; a job says
 * what must happen and is run exactly by the handler that owns it. Work that
 * genuinely has several interested parties belongs on the bus, and one of those
 * subscribers can queue a job.
 *
 * **Identifiers, not credentials — with one deliberate exception.** A payload
 * here is written to Redis and, if the job exhausts its retries, copied into a
 * dead-letter record that sits until a person reads it. The magic link job
 * carries a plaintext token because the token *is* the work: there is nothing
 * else to send. That is why `redactAppJobPayload` exists, and why it is applied
 * on the dead-letter path rather than left to a reviewer to remember.
 *
 * **Serialisable, and small.** BullMQ JSON-encodes the payload, so a `Date`
 * arrives as a string and a `Buffer` as an object of numbers. Epoch
 * milliseconds and ids only; anything larger than a few kilobytes belongs in
 * object storage with the key in the payload.
 *
 * A `type` rather than an `interface`, for the reason `JobPayloadMap` gives.
 */
export type AppJobPayloads = {
  /**
   * Deliver an issued magic link to its owner's inbox.
   *
   * Queued rather than sent inline because mail delivery is a third-party HTTP
   * call on the path of an endpoint that is deliberately reachable without
   * credentials: inline, a slow provider becomes a slow login endpoint and a
   * down provider becomes a 500 the user reads as "login is broken". Queued, a
   * provider outage is retried over a couple of minutes and the request that
   * issued the link returns 202 either way.
   */
  'auth.magic-link.deliver': {
    email: string;
    /**
     * The plaintext token — a bearer credential, at rest in Redis for as long
     * as the job lives. Kept out of dead-letter records by
     * `redactAppJobPayload`, and out of logs by never being interpolated into
     * one.
     */
    token: string;
    /** Epoch milliseconds after which the link stops working. */
    expiresAt: number;
  };
};

export const MAGIC_LINK_DELIVERY_JOB = 'auth.magic-link.deliver';

/** What a redacted field is replaced with. Fixed, so it is greppable. */
export const REDACTED = '[redacted]';

/**
 * Strips credentials from a payload on its way into the dead-letter queue.
 *
 * The redaction is per job name rather than per field name across the board:
 * "blank anything called `token`" reads as safer and is not, because it fails
 * silently the first time somebody names a field `secret` or nests one a level
 * down. Naming the job that has a credential is a decision a reviewer can check
 * against the map above.
 *
 * The consequence is stated in `replay.ts`: a redacted record cannot be
 * replayed, so a magic link that exhausted its retries has to be re-requested
 * by the user. That is the right outcome anyway — by the time anyone reads the
 * record, the link has expired.
 */
export function redactAppJobPayload(jobName: string, payload: unknown): unknown {
  if (jobName !== MAGIC_LINK_DELIVERY_JOB) return payload;
  if (typeof payload !== 'object' || payload === null) return payload;

  return { ...payload, token: REDACTED };
}
