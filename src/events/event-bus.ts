import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

/**
 * The shape a bus is parameterised by: event name → payload type.
 *
 * The map a caller supplies (see `DomainEventPayloads`) declares literal names,
 * so `keyof` produces a closed union — which is what makes
 * `publish('user.craeted', …)` a compile error rather than a listener that
 * silently never fires, the one failure mode a bare `EventEmitter` cannot
 * protect against.
 *
 * It must be a `type` alias, not an `interface`: only the former gets an
 * implicit index signature, and without one it does not satisfy this
 * constraint. An interface is open to declaration merging, so TypeScript
 * refuses to assume its keys are final.
 */
export type EventPayloadMap = Record<string, unknown>;

/**
 * The envelope every handler receives, rather than the bare payload.
 *
 * The metadata is not decoration: `id` lets a subscriber deduplicate a replay,
 * `occurredAt` is the time the fact happened rather than the time a handler got
 * round to it, and `correlationId` carries the publishing request's
 * `x-correlation-id` so an audit line written by a subscriber can be joined
 * back to the access log entry for the request that caused it. A payload alone
 * loses all three the moment it leaves the publisher.
 */
export interface DomainEvent<TName extends string = string, TPayload = unknown> {
  readonly id: string;
  readonly name: TName;
  readonly occurredAt: Date;
  /** The publishing request's correlation id, when it was published in one. */
  readonly correlationId: string | null;
  readonly payload: TPayload;
}

/**
 * A subscriber. May be async: `publish` collects the returned promise and waits
 * for it, so a handler that awaits I/O is not silently abandoned the way an
 * async listener on a raw `EventEmitter` is.
 */
export type EventHandler<TName extends string, TPayload> = (
  event: DomainEvent<TName, TPayload>,
) => void | Promise<void>;

/** Returned by `on`/`once`. Idempotent — calling it twice is harmless. */
export type Unsubscribe = () => void;

export interface PublishOptions {
  /** Usually `correlationIdOf(req)`. Omitted for events published outside a request. */
  correlationId?: string | undefined;
}

/** Where a handler failure goes. See `EventBusOptions.onHandlerError`. */
export type HandlerErrorReporter = (
  error: Error,
  event: DomainEvent,
  context: { readonly handlerName: string },
) => void;

export interface EventBus<TEvents extends EventPayloadMap> {
  /** Subscribes until the returned function is called. */
  on<K extends keyof TEvents & string>(name: K, handler: EventHandler<K, TEvents[K]>): Unsubscribe;

  /** Subscribes for exactly one delivery. */
  once<K extends keyof TEvents & string>(name: K, handler: EventHandler<K, TEvents[K]>): Unsubscribe;

  /**
   * Announces that something happened, and resolves once every handler has
   * settled.
   *
   * Never rejects because of a subscriber: a handler that throws or rejects is
   * reported through `onHandlerError` and the others still run. Awaiting is
   * therefore about ordering — "the invalidation has run" — never about
   * success, and a publisher that does not care can leave the promise
   * unawaited without risking an unhandled rejection.
   */
  publish<K extends keyof TEvents & string>(
    name: K,
    payload: TEvents[K],
    options?: PublishOptions,
  ): Promise<void>;

  listenerCount(name: keyof TEvents & string): number;

  /** Drops subscribers. Exists for test teardown; nothing in a request path should call it. */
  removeAllListeners(name?: keyof TEvents & string): void;
}

export interface EventBusOptions {
  /**
   * Called when a handler throws or rejects. Defaults to `console.error`.
   *
   * This is the whole isolation policy in one hook. The alternative — letting
   * the failure propagate — means a broken audit subscriber returns 500 for a
   * write that already committed, which is strictly worse than a missing audit
   * line. The cost is real and worth stating plainly: a failed handler is
   * *reported*, not retried, so any consequence that must not be lost belongs
   * on the publisher's own error path (or, once it exists, the transactional
   * outbox from Phase 7) rather than in a subscriber.
   */
  onHandlerError?: HandlerErrorReporter;

  /**
   * Per-event listener ceiling before Node prints its leak warning. Default 20.
   *
   * Node's default of 10 exists to catch a listener added per request; our
   * subscribers are registered once at boot, so the ceiling is raised
   * deliberately rather than left to warn on a legitimate eleventh subscriber.
   * It is raised, not removed: a bus that accepts unbounded listeners cannot
   * tell a growing subscriber list from an actual leak.
   */
  maxListenersPerEvent?: number;

  /** Injected so `occurredAt` is deterministic under test. */
  now?: () => Date;

  /** Injected so `id` is deterministic under test. */
  newId?: () => string;
}

/**
 * Names `EventEmitter` gives its own meaning to.
 *
 * `error` is the dangerous one: emitting it with no listener attached makes the
 * emitter *throw* into the publisher, which is precisely the coupling this bus
 * exists to prevent. `newListener`/`removeListener` fire on registration and
 * would deliver emitter internals to a handler expecting a `DomainEvent`. The
 * type parameter already discourages all three; this guard makes it an error
 * rather than a subtle misbehaviour for callers who reach the bus untyped.
 */
const RESERVED_EVENT_NAMES: ReadonlySet<string> = new Set([
  'error',
  'newListener',
  'removeListener',
]);

/**
 * How a registered subscriber is actually stored on the emitter.
 *
 * The second argument is the trick that makes an async-aware bus out of a
 * synchronous emitter: `publish` hands each listener a collector, the wrapper
 * pushes its (already isolated) promise into it, and `publish` awaits them all.
 * Dispatch still goes through `emitter.emit`, so `once` removal, listener
 * counts and leak warnings keep working — none of which survives snapshotting
 * `emitter.listeners()` and calling them by hand.
 */
type ListenerWrapper = (event: DomainEvent, collect: (settled: Promise<void>) => void) => void;

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

const defaultErrorReporter: HandlerErrorReporter = (error, event, { handlerName }) => {
  console.error(
    `[event-bus] handler "${handlerName}" failed for ${event.name} (${event.id}):`,
    error,
  );
};

/**
 * A typed, error-isolating facade over a single Node `EventEmitter`.
 *
 * Three things the raw emitter cannot do, in the order they bite:
 *
 * 1. **Types.** `emit('user.deleted', payload)` accepts any string and any
 *    arguments, so a typo is a listener that never runs and a payload change is
 *    a runtime `undefined` in a subscriber. Here both are compile errors.
 * 2. **Async.** `emit` ignores what a listener returns, so an `async` listener
 *    that rejects becomes an unhandled rejection — which, since Node 15,
 *    terminates the process by default. Every handler here is wrapped before it
 *    is registered, so there is no promise the bus does not own.
 * 3. **Isolation.** A listener that throws synchronously throws *out of
 *    `emit`*, into whichever request happened to publish. A subscriber is by
 *    definition something the publisher does not depend on; letting it fail the
 *    publisher inverts that.
 *
 * What it deliberately is not: durable, ordered, or cross-process. Handlers run
 * concurrently, in-process, at most once, and an event published while a
 * subscriber is down is simply gone. Anything needing delivery guarantees wants
 * the outbox pattern, not a bigger `EventEmitter`.
 */
export function createEventBus<TEvents extends EventPayloadMap>(
  options: EventBusOptions = {},
): EventBus<TEvents> {
  const {
    onHandlerError = defaultErrorReporter,
    maxListenersPerEvent = 20,
    now = () => new Date(),
    newId = randomUUID,
  } = options;

  if (!Number.isInteger(maxListenersPerEvent) || maxListenersPerEvent < 1) {
    throw new RangeError(
      `createEventBus: maxListenersPerEvent must be an integer >= 1, received ${maxListenersPerEvent}`,
    );
  }

  const emitter = new EventEmitter();
  emitter.setMaxListeners(maxListenersPerEvent);

  function assertUsableName(name: string): void {
    if (RESERVED_EVENT_NAMES.has(name)) {
      throw new RangeError(`createEventBus: "${name}" is reserved by EventEmitter`);
    }
  }

  /** Reporting must not become its own failure. */
  function report(error: Error, event: DomainEvent, handlerName: string): void {
    try {
      onHandlerError(error, event, { handlerName });
    } catch {
      // A reporter that throws would turn one lost subscriber into a rejected
      // publish, which is the exact coupling this function exists to break.
    }
  }

  /**
   * Runs one handler and swallows its failure into `report`.
   *
   * Total by construction: both the synchronous throw and the rejection land in
   * the same `catch`, so the returned promise always fulfils.
   */
  async function runIsolated<TName extends string, TPayload>(
    handler: EventHandler<TName, TPayload>,
    event: DomainEvent<TName, TPayload>,
  ): Promise<void> {
    try {
      await handler(event);
    } catch (err) {
      report(toError(err), event, handler.name === '' ? '<anonymous>' : handler.name);
    }
  }

  function subscribe<K extends keyof TEvents & string>(
    name: K,
    handler: EventHandler<K, TEvents[K]>,
    mode: 'on' | 'once',
  ): Unsubscribe {
    assertUsableName(name);

    const wrapper: ListenerWrapper = (event, collect) => {
      collect(runIsolated(handler, event as DomainEvent<K, TEvents[K]>));
    };

    emitter[mode](name, wrapper);

    return () => {
      emitter.off(name, wrapper);
    };
  }

  return {
    on(name, handler) {
      return subscribe(name, handler, 'on');
    },

    once(name, handler) {
      return subscribe(name, handler, 'once');
    },

    async publish(name, payload, publishOptions = {}) {
      assertUsableName(name);

      const event: DomainEvent<typeof name, typeof payload> = {
        id: newId(),
        name,
        occurredAt: now(),
        correlationId: publishOptions.correlationId ?? null,
        payload,
      };

      const settled: Promise<void>[] = [];
      emitter.emit(name, event, (promise: Promise<void>) => settled.push(promise));

      // `Promise.all` rather than `allSettled`: every promise in here came from
      // `runIsolated` and therefore cannot reject. If one ever does, that is a
      // bug in the isolation itself and should surface loudly rather than be
      // swallowed by an `allSettled` nobody inspects.
      await Promise.all(settled);
    },

    listenerCount(name) {
      return emitter.listenerCount(name);
    },

    removeAllListeners(name) {
      if (name === undefined) {
        emitter.removeAllListeners();
      } else {
        emitter.removeAllListeners(name);
      }
    },
  };
}
