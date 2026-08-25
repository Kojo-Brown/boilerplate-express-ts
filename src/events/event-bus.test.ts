import type { DomainEvent, HandlerErrorReporter } from '@/events/event-bus';
import { createEventBus } from '@/events/event-bus';

type TestEvents = {
  'thing.created': { id: string };
  'thing.deleted': { id: string };
};

/** A bus whose envelope metadata is fixed, so assertions can name it. */
function makeBus(onHandlerError?: HandlerErrorReporter) {
  let sequence = 0;
  return createEventBus<TestEvents>({
    ...(onHandlerError ? { onHandlerError } : {}),
    now: () => new Date('2024-05-01T12:00:00.000Z'),
    newId: () => `event-${(sequence += 1)}`,
  });
}

/** Silences the default reporter's `console.error` for the failure tests. */
const silent: HandlerErrorReporter = () => undefined;

describe('createEventBus — delivery', () => {
  it('delivers the payload to a subscriber of that event', async () => {
    const bus = makeBus();
    const seen: { id: string }[] = [];
    bus.on('thing.created', (event) => {
      seen.push(event.payload);
    });

    await bus.publish('thing.created', { id: 'thing-1' });

    expect(seen).toEqual([{ id: 'thing-1' }]);
  });

  it('does not deliver an event to subscribers of a different name', async () => {
    const bus = makeBus();
    const deletions: DomainEvent[] = [];
    bus.on('thing.deleted', (event) => {
      deletions.push(event);
    });

    await bus.publish('thing.created', { id: 'thing-1' });

    expect(deletions).toEqual([]);
  });

  it('wraps the payload in an envelope carrying id, name and time', async () => {
    const bus = makeBus();
    let received: DomainEvent<'thing.created', { id: string }> | undefined;
    bus.on('thing.created', (event) => {
      received = event;
    });

    await bus.publish('thing.created', { id: 'thing-1' });

    expect(received).toEqual({
      id: 'event-1',
      name: 'thing.created',
      occurredAt: new Date('2024-05-01T12:00:00.000Z'),
      correlationId: null,
      payload: { id: 'thing-1' },
    });
  });

  it('carries the publisher’s correlation id through to the handler', async () => {
    const bus = makeBus();
    const ids: (string | null)[] = [];
    bus.on('thing.created', (event) => {
      ids.push(event.correlationId);
    });

    await bus.publish('thing.created', { id: 'a' }, { correlationId: 'req-abc' });
    await bus.publish('thing.created', { id: 'b' });

    expect(ids).toEqual(['req-abc', null]);
  });

  it('gives every publish a distinct event id', async () => {
    const bus = makeBus();
    const ids: string[] = [];
    bus.on('thing.created', (event) => {
      ids.push(event.id);
    });

    await bus.publish('thing.created', { id: 'a' });
    await bus.publish('thing.created', { id: 'b' });

    expect(new Set(ids).size).toBe(2);
  });

  it('resolves without complaint when nobody is listening', async () => {
    const bus = makeBus();
    await expect(bus.publish('thing.created', { id: 'thing-1' })).resolves.toBeUndefined();
  });

  it('runs every subscriber for the event', async () => {
    const bus = makeBus();
    const calls: string[] = [];
    bus.on('thing.created', () => {
      calls.push('first');
    });
    bus.on('thing.created', () => {
      calls.push('second');
    });

    await bus.publish('thing.created', { id: 'thing-1' });

    expect(calls).toEqual(['first', 'second']);
  });
});

describe('createEventBus — async handlers', () => {
  it('waits for an async handler before resolving', async () => {
    const bus = makeBus();
    let finished = false;
    bus.on('thing.created', async () => {
      await Promise.resolve();
      await Promise.resolve();
      finished = true;
    });

    await bus.publish('thing.created', { id: 'thing-1' });

    // The whole reason `publish` collects promises: `emitter.emit` alone would
    // have returned with `finished` still false.
    expect(finished).toBe(true);
  });

  it('waits for the slowest of several handlers', async () => {
    jest.useFakeTimers();
    try {
      const bus = makeBus();
      const done: string[] = [];
      bus.on('thing.created', async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        done.push('fast');
      });
      bus.on('thing.created', async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        done.push('slow');
      });

      const settled = bus.publish('thing.created', { id: 'thing-1' });
      await jest.advanceTimersByTimeAsync(50);
      await settled;

      expect(done).toEqual(['fast', 'slow']);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('createEventBus — failure isolation', () => {
  it('does not reject when a handler throws synchronously', async () => {
    const bus = makeBus(silent);
    bus.on('thing.created', () => {
      throw new Error('subscriber exploded');
    });

    await expect(bus.publish('thing.created', { id: 'thing-1' })).resolves.toBeUndefined();
  });

  it('does not reject when an async handler rejects', async () => {
    const bus = makeBus(silent);
    bus.on('thing.created', async () => {
      await Promise.resolve();
      throw new Error('subscriber exploded later');
    });

    await expect(bus.publish('thing.created', { id: 'thing-1' })).resolves.toBeUndefined();
  });

  it('still runs the other subscribers when one fails', async () => {
    const bus = makeBus(silent);
    const survived: string[] = [];
    bus.on('thing.created', () => {
      throw new Error('first exploded');
    });
    bus.on('thing.created', () => {
      survived.push('second ran');
    });

    await bus.publish('thing.created', { id: 'thing-1' });

    expect(survived).toEqual(['second ran']);
  });

  it('reports the failure with the event and the handler’s name', async () => {
    const onHandlerError = jest.fn();
    const bus = makeBus(onHandlerError);
    const boom = new Error('subscriber exploded');
    bus.on('thing.created', function auditSubscriber() {
      throw boom;
    });

    await bus.publish('thing.created', { id: 'thing-1' });

    expect(onHandlerError).toHaveBeenCalledTimes(1);
    expect(onHandlerError).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({ id: 'event-1', name: 'thing.created' }),
      { handlerName: 'auditSubscriber' },
    );
  });

  it('normalises a non-Error throw into an Error before reporting', async () => {
    const onHandlerError = jest.fn();
    const bus = makeBus(onHandlerError);
    bus.on('thing.created', () => {
      throw 'just a string';
    });

    await bus.publish('thing.created', { id: 'thing-1' });

    const [error] = onHandlerError.mock.calls[0] as [Error];
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('just a string');
  });

  it('survives a reporter that throws, rather than failing the publish', async () => {
    const bus = makeBus(() => {
      throw new Error('the logger is down too');
    });
    bus.on('thing.created', () => {
      throw new Error('subscriber exploded');
    });

    await expect(bus.publish('thing.created', { id: 'thing-1' })).resolves.toBeUndefined();
  });
});

describe('createEventBus — subscription lifecycle', () => {
  it('stops delivering after unsubscribe', async () => {
    const bus = makeBus();
    const seen: string[] = [];
    const unsubscribe = bus.on('thing.created', (event) => {
      seen.push(event.payload.id);
    });

    await bus.publish('thing.created', { id: 'first' });
    unsubscribe();
    await bus.publish('thing.created', { id: 'second' });

    expect(seen).toEqual(['first']);
  });

  it('tolerates unsubscribing twice', async () => {
    const bus = makeBus();
    const unsubscribe = bus.on('thing.created', () => undefined);

    unsubscribe();
    expect(() => unsubscribe()).not.toThrow();
    expect(bus.listenerCount('thing.created')).toBe(0);
  });

  it('delivers a `once` subscriber exactly one event', async () => {
    const bus = makeBus();
    const seen: string[] = [];
    bus.once('thing.created', (event) => {
      seen.push(event.payload.id);
    });

    await bus.publish('thing.created', { id: 'first' });
    await bus.publish('thing.created', { id: 'second' });

    expect(seen).toEqual(['first']);
    expect(bus.listenerCount('thing.created')).toBe(0);
  });

  it('lets a `once` subscriber be cancelled before it ever fires', async () => {
    const bus = makeBus();
    const seen: string[] = [];
    const unsubscribe = bus.once('thing.created', (event) => {
      seen.push(event.payload.id);
    });

    unsubscribe();
    await bus.publish('thing.created', { id: 'first' });

    expect(seen).toEqual([]);
  });

  it('counts listeners per event name', () => {
    const bus = makeBus();
    bus.on('thing.created', () => undefined);
    bus.on('thing.created', () => undefined);
    bus.on('thing.deleted', () => undefined);

    expect(bus.listenerCount('thing.created')).toBe(2);
    expect(bus.listenerCount('thing.deleted')).toBe(1);
  });

  it('removes listeners for one name without touching the others', () => {
    const bus = makeBus();
    bus.on('thing.created', () => undefined);
    bus.on('thing.deleted', () => undefined);

    bus.removeAllListeners('thing.created');

    expect(bus.listenerCount('thing.created')).toBe(0);
    expect(bus.listenerCount('thing.deleted')).toBe(1);
  });

  it('removes every listener when given no name', () => {
    const bus = makeBus();
    bus.on('thing.created', () => undefined);
    bus.on('thing.deleted', () => undefined);

    bus.removeAllListeners();

    expect(bus.listenerCount('thing.created')).toBe(0);
    expect(bus.listenerCount('thing.deleted')).toBe(0);
  });
});

describe('createEventBus — guards', () => {
  // These names are only reachable from untyped code; the type parameter keeps
  // them out of `publish`/`on` for anyone using the bus as intended. The guard
  // exists because `emit('error')` with no listener *throws into the
  // publisher*, which is the one thing this bus promises cannot happen.
  const reserved = ['error', 'newListener', 'removeListener'] as const;

  it.each(reserved)('refuses to subscribe to the reserved name %s', (name) => {
    const bus = createEventBus<Record<string, unknown>>();
    expect(() => bus.on(name, () => undefined)).toThrow(/reserved by EventEmitter/);
  });

  it.each(reserved)('refuses to publish the reserved name %s', async (name) => {
    const bus = createEventBus<Record<string, unknown>>();
    await expect(bus.publish(name, {})).rejects.toThrow(/reserved by EventEmitter/);
  });

  it('rejects a nonsensical listener ceiling at construction', () => {
    expect(() => createEventBus({ maxListenersPerEvent: 0 })).toThrow(RangeError);
    expect(() => createEventBus({ maxListenersPerEvent: 2.5 })).toThrow(RangeError);
  });

  it('does not warn about a leak below the configured ceiling', () => {
    const warn = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    try {
      const bus = createEventBus<TestEvents>({ maxListenersPerEvent: 12 });
      for (let i = 0; i < 12; i += 1) bus.on('thing.created', () => undefined);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('createEventBus — the shared payload', () => {
  it('stops one subscriber from editing what the next one sees', async () => {
    const bus = makeBus();

    let attempt: unknown;
    bus.on('thing.created', (event) => {
      try {
        // The cast is the point: subscribers get `DeepReadonly<TPayload>`, so
        // this line does not compile without it. What the freeze adds is the
        // answer for the caller who wrote the cast anyway, or who reached the
        // bus through an erased `DomainEvent`.
        (event.payload as { id: string }).id = 'edited';
      } catch (error) {
        attempt = error;
      }
    });

    const seen: string[] = [];
    bus.on('thing.created', (event) => {
      seen.push(event.payload.id);
    });

    await bus.publish('thing.created', { id: 'thing-1' });

    expect(attempt).toBeInstanceOf(TypeError);
    expect(seen).toEqual(['thing-1']);
  });

  it('freezes the envelope as well as the payload', async () => {
    const bus = makeBus();

    let envelope: DomainEvent<'thing.created', { id: string }> | undefined;
    bus.on('thing.created', (event) => {
      envelope = event as DomainEvent<'thing.created', { id: string }>;
    });

    await bus.publish('thing.created', { id: 'thing-1' });

    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope?.payload)).toBe(true);

    // `occurredAt` is left writable on purpose: `Object.freeze` cannot stop
    // `setUTCFullYear`, and pretending otherwise is worse than not claiming it.
    expect(Object.isFrozen(envelope?.occurredAt)).toBe(false);
  });

  it('freezes the publisher’s object, since that is the one it fanned out', async () => {
    const bus = makeBus();
    const payload = { id: 'thing-1' };

    await bus.publish('thing.created', payload);

    // A payload edited after publishing was never a statement about a moment,
    // which is the only thing an event can be.
    expect(Object.isFrozen(payload)).toBe(true);
  });
});

describe('createEventBus — a republished event', () => {
  it('takes the id the publisher supplies, so a redelivery is recognisable', async () => {
    const bus = makeBus();
    const ids: string[] = [];
    bus.on('thing.created', (event) => {
      ids.push(event.id);
    });

    // The outbox relay may deliver one stored message more than once. A fresh
    // id each time would make the second delivery indistinguishable from a
    // second event, which is the one thing a consumer must be able to tell
    // apart under at-least-once delivery.
    await bus.publish('thing.created', { id: 'thing-1' }, { eventId: 'outbox-row-1' });
    await bus.publish('thing.created', { id: 'thing-1' }, { eventId: 'outbox-row-1' });

    expect(ids).toEqual(['outbox-row-1', 'outbox-row-1']);
  });

  it('takes the time the fact happened over the time it was delivered', async () => {
    const bus = makeBus();
    let occurredAt: Date | undefined;
    bus.on('thing.created', (event) => {
      occurredAt = event.occurredAt;
    });

    const enqueuedAt = new Date('2024-04-30T09:00:00.000Z');
    await bus.publish('thing.created', { id: 'thing-1' }, { occurredAt: enqueuedAt });

    // An audit line stamped with the relay's schedule records the relay.
    expect(occurredAt).toEqual(enqueuedAt);
  });

  it('still mints both when the publisher is stating the fact for the first time', async () => {
    const bus = makeBus();
    let envelope: DomainEvent<'thing.created', { id: string }> | undefined;
    bus.on('thing.created', (event) => {
      envelope = event as DomainEvent<'thing.created', { id: string }>;
    });

    await bus.publish('thing.created', { id: 'thing-1' });

    expect(envelope?.id).toBe('event-1');
    expect(envelope?.occurredAt).toEqual(new Date('2024-05-01T12:00:00.000Z'));
  });
});

describe('createEventBus — a publisher that needs to know', () => {
  it('reports this publish’s handler failures to the publisher, not the bus', async () => {
    const busReporter = jest.fn();
    const bus = makeBus(busReporter);
    const publishReporter = jest.fn();

    bus.on('thing.created', async function failingHandler() {
      throw new Error('sink unreachable');
    });

    await bus.publish('thing.created', { id: 'thing-1' }, { onHandlerError: publishReporter });

    expect(publishReporter).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'sink unreachable' }),
      expect.objectContaining({ name: 'thing.created' }),
      { handlerName: 'failingHandler' },
    );
    // One incident, reported once. The caller that asked is the one that knows
    // what it means — see the outbox dispatcher, which turns it into a retry.
    expect(busReporter).not.toHaveBeenCalled();
  });

  it('isolates handlers exactly as before — publish still resolves', async () => {
    const bus = makeBus(silent);
    const healthy = jest.fn();

    bus.on('thing.created', async () => {
      throw new Error('boom');
    });
    bus.on('thing.created', healthy);

    await expect(
      bus.publish('thing.created', { id: 'thing-1' }, { onHandlerError: () => undefined }),
    ).resolves.toBeUndefined();
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it('does not let a throwing per-publish reporter fail the publish', async () => {
    const bus = makeBus(silent);
    bus.on('thing.created', async () => {
      throw new Error('boom');
    });

    await expect(
      bus.publish('thing.created', { id: 'thing-1' }, {
        onHandlerError: () => {
          throw new Error('the reporter is broken too');
        },
      }),
    ).resolves.toBeUndefined();
  });

  it('falls back to the bus reporter for a publish that did not ask', async () => {
    const busReporter = jest.fn();
    const bus = makeBus(busReporter);
    bus.on('thing.created', async () => {
      throw new Error('boom');
    });

    await bus.publish('thing.created', { id: 'thing-1' });

    expect(busReporter).toHaveBeenCalledTimes(1);
  });
});
