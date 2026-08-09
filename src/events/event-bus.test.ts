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
