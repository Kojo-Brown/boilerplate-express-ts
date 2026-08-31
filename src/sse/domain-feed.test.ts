import { createEventBus } from '@/events/event-bus';
import { DOMAIN_EVENT_NAMES } from '@/events/domain-events';
import type { DomainEventBus, DomainEventPayloads } from '@/events/domain-events';
import { attachDomainEventFeed } from '@/sse/domain-feed';
import type { DomainEventFrame } from '@/sse/domain-feed';
import { createSseHub } from '@/sse/hub';
import type { SseHub } from '@/sse/hub';

type Published = { event: string; payload: unknown };

/** A hub reduced to the one method the feed uses. */
function recordingHub(): { hub: SseHub; published: Published[] } {
  const published: Published[] = [];
  const hub = {
    publish(event: string, payload: unknown) {
      published.push({ event, payload });
      return { id: `x:${published.length}`, event, data: JSON.stringify(payload) };
    },
  } as unknown as SseHub;

  return { hub, published };
}

function busOf(): DomainEventBus {
  return createEventBus<DomainEventPayloads>({
    now: () => new Date('2026-03-04T05:06:07.000Z'),
    newId: () => 'evt-1',
  });
}

describe('attachDomainEventFeed', () => {
  it('subscribes to every event this build knows about', () => {
    // Iterating `DOMAIN_EVENT_NAMES` rather than listing names is what keeps an
    // event added later from silently missing the stream: that constant is held
    // exhaustive against `DomainEventPayloads` by a compile-time assertion.
    const bus = busOf();
    attachDomainEventFeed(bus, recordingHub().hub);

    for (const name of DOMAIN_EVENT_NAMES) {
      expect(bus.listenerCount(name)).toBe(1);
    }
  });

  it('publishes the envelope flattened, under the event name', async () => {
    const bus = busOf();
    const { hub, published } = recordingHub();
    attachDomainEventFeed(bus, hub);

    await bus.publish(
      'user.created',
      { userId: 'u1', email: 'new@example.com', roles: ['user'], actorId: 'admin-1' },
      { correlationId: 'corr-1' },
    );

    expect(published).toHaveLength(1);
    expect(published[0]?.event).toBe('user.created');
    expect(published[0]?.payload).toEqual({
      id: 'evt-1',
      occurredAt: '2026-03-04T05:06:07.000Z',
      correlationId: 'corr-1',
      payload: { userId: 'u1', email: 'new@example.com', roles: ['user'], actorId: 'admin-1' },
    });
  });

  it('keeps the bus event id distinct from the cursor the stream is resumed by', async () => {
    // They answer different questions. The bus id is the identity of the fact
    // and is *stable across a redelivery* — the outbox relay republishes a
    // stored message under its original id — while the SSE id is a position in
    // this process's replay log and must advance on every frame. Using one for
    // the other would make a cursor ambiguous the moment an event is
    // republished, and a replay unorderable.
    const bus = busOf();
    const hub = createSseHub({ replayBufferSize: 4, maxConnections: 2, streamId: 'run' });
    attachDomainEventFeed(bus, hub);

    const seen: string[] = [];
    hub.attach(
      {
        closed: false,
        send: (m) => seen.push(`${m.id}|${(JSON.parse(m.data) as DomainEventFrame).id}`),
        control: () => undefined,
        comment: () => undefined,
        close: () => undefined,
        onClose: () => undefined,
      },
      undefined,
    );

    await bus.publish('user.deleted', { userId: 'u1', actorId: null }, { eventId: 'evt-9' });
    await bus.publish('user.deleted', { userId: 'u2', actorId: null }, { eventId: 'evt-9' });

    // Same fact id twice — a redelivery — and two distinct cursors.
    expect(seen).toEqual(['run:1|evt-9', 'run:2|evt-9']);
  });

  it('reports a correlationId of null for an event published outside a request', async () => {
    const bus = busOf();
    const { hub, published } = recordingHub();
    attachDomainEventFeed(bus, hub);

    await bus.publish('auth.session.revoked', { userId: 'u1', scope: 'all' });

    expect((published[0]?.payload as DomainEventFrame).correlationId).toBeNull();
  });

  it('stops forwarding once unsubscribed', async () => {
    const bus = busOf();
    const { hub, published } = recordingHub();
    const detach = attachDomainEventFeed(bus, hub);

    detach();
    await bus.publish('user.deleted', { userId: 'u1', actorId: null });

    expect(published).toEqual([]);
    for (const name of DOMAIN_EVENT_NAMES) {
      expect(bus.listenerCount(name)).toBe(0);
    }
  });

  it('cannot fail the publisher when the hub throws', async () => {
    // The isolation is the bus's, not this module's, and it is the property
    // that makes an event stream safe to attach to a request path: a broken
    // subscriber must not turn a committed write into a 500.
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const bus = busOf();
    const hub = {
      publish(): never {
        throw new Error('hub is broken');
      },
    } as unknown as SseHub;
    attachDomainEventFeed(bus, hub);

    await expect(bus.publish('user.deleted', { userId: 'u1', actorId: null })).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
