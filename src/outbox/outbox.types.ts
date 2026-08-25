import type { EventPayloadMap } from '@/events/event-bus';
import type { TransactionClient } from '@/db/transaction';

/**
 * A value that survives a round trip through `jsonb` unchanged.
 *
 * The outbox is the first place in this codebase where a payload is written to
 * disk and read back by a *different* process, and the type that describes it
 * on the way out is the same one a subscriber is handed on the way in. That
 * makes an unserialisable field a lie rather than an inconvenience: a `Date`
 * goes into `payload` as an ISO string and comes back a string, so the
 * subscriber's `occurredAt.getTime()` is a `TypeError` in the relay and nowhere
 * near the enqueue that caused it. A `Map` or a `Set` is worse — it serialises
 * to `{}` and fails nothing at all.
 *
 * So the enqueue signature asks for the intersection of the declared payload
 * and this, which resolves to `never` at any property JSON cannot carry. The
 * error lands at the call site, on the offending field.
 *
 * `undefined` is deliberately absent from the primitives: `JSON.stringify`
 * *drops* an `undefined` property rather than encoding it, so a payload that
 * distinguishes "absent" from "explicitly nothing" cannot be stored. Domain
 * payloads here use `null`, which round-trips.
 */
export type JsonPrimitive = string | number | boolean | null;

export type JsonSafe<T> = T extends JsonPrimitive
  ? T
  : T extends readonly (infer TElement)[]
    ? readonly JsonSafe<TElement>[]
    : // Spelled as a call signature rather than `Function`, which the lint rule
      // set bans outright — the branch exists to reject callables, so naming the
      // banned type to do it would be a silenced rule for no gain.
      T extends (...args: never[]) => unknown
      ? never
      : T extends Date | RegExp | Map<unknown, unknown> | Set<unknown>
        ? never
        : T extends object
          ? { readonly [K in keyof T]: JsonSafe<T[K]> }
          : never;

/**
 * One row of `outbox_messages`, as the relay reads it back.
 *
 * `payload` is `unknown` and that is not laziness. What comes out of `jsonb` is
 * whatever some earlier — possibly older — deployment put in, so the typed map
 * that governed the enqueue governs nothing here. The name is checked against
 * the runtime event table at the dispatcher (see `createEventBusDispatcher`),
 * and that is the single boundary where the shape is asserted rather than
 * known.
 */
export interface OutboxMessage {
  readonly id: string;
  readonly name: string;
  readonly payload: unknown;
  readonly correlationId: string | null;
  readonly occurredAt: Date;
  /** Deliveries already attempted. `0` on the first. */
  readonly attempts: number;
}

/**
 * Where a claimed message is handed to.
 *
 * **Throwing is how it says "not delivered".** A dispatcher that resolves has
 * asserted that the message reached whatever it is a boundary to, because the
 * relay deletes the row on that promise fulfilling. One that swallows its own
 * failures turns the whole table into a slower `EventEmitter`.
 */
export type OutboxDispatcher = (message: OutboxMessage) => Promise<void>;

export interface EnqueueOptions {
  /** Usually `context.correlationId`. Null for work published outside a request. */
  readonly correlationId?: string | null;
  /**
   * Overrides the generated message id, which is also the `DomainEvent.id` the
   * subscriber will see. Injected by tests; in production the store generates
   * it, because an id supplied by a caller is an id two callers can supply.
   */
  readonly id?: string;
}

/**
 * The durable half of publishing.
 *
 * Parameterised by the same event map as `EventBus`, so the two agree on names
 * and payloads by construction: `enqueue(tx, 'user.craeted', …)` is the same
 * compile error as `publish` would give, rather than a row nothing will ever
 * recognise.
 */
export interface OutboxStore<TEvents extends EventPayloadMap> {
  /**
   * Records an event for delivery, in the caller's transaction.
   *
   * The `TransactionClient` is the entire pattern, expressed as a type. An
   * enqueue that runs on the pool lands on a *different* connection: it commits
   * whether or not the write it describes does, so the failure mode inverts —
   * instead of losing an event for a row that exists, the service announces a
   * user that was rolled back, and the subscriber acting on it has nothing to
   * read. Neither symptom appears in a single-request test, which is why this
   * is a compile error and not a convention. It is the same brand the row-lock
   * helpers take, and for the same reason.
   *
   * Returns the message id — the id the subscriber will see as `event.id`, so
   * the enqueuing request can log it without waiting for delivery.
   */
  enqueue<K extends keyof TEvents & string>(
    tx: TransactionClient,
    name: K,
    payload: TEvents[K] & JsonSafe<TEvents[K]>,
    options?: EnqueueOptions,
  ): Promise<string>;

  /**
   * Locks up to `limit` due messages for the rest of `tx` and returns them.
   *
   * Locked, not marked: the claim is a row lock held by the transaction, so a
   * relay that dies mid-batch releases its rows the moment its connection does.
   * A `status = 'in_flight'` column instead would need a lease, a clock, and a
   * sweep to recover the same rows — and a lease that expires while the
   * dispatcher is still running redelivers a message *concurrently* with
   * itself, which a lock cannot do.
   *
   * May return fewer rows than `limit` while another relay holds some of them.
   * That is `SKIP LOCKED` working, not the queue being empty.
   */
  claimDue(tx: TransactionClient, limit: number): Promise<OutboxMessage[]>;

  /** Delivered: the row is gone. Must run in the transaction that claimed it. */
  remove(tx: TransactionClient, id: string): Promise<void>;

  /** Failed, but not out of attempts: bump the count and push `available_at` out. */
  reschedule(tx: TransactionClient, id: string, delayMs: number, reason: string): Promise<void>;

  /** Failed for the last time: park it for a human, and stop claiming it. */
  deadLetter(tx: TransactionClient, id: string, reason: string): Promise<void>;
}
