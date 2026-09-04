import type { OutboxMessage } from '@/outbox/outbox.types';
import { decodeEnvelope } from '@/redis/stream.envelope';
import { MemoryStreamCommands } from '@/redis/stream.memory';
import { createStreamOutboxDispatcher } from '@/redis/stream.dispatcher';
import { createStreamPublisher } from '@/redis/stream.publisher';

const KEY = 'test-events';

const message: OutboxMessage = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'user.created',
  payload: { userId: 'user-1', roles: ['admin'], actorId: null },
  correlationId: 'corr-1',
  occurredAt: new Date('2026-09-04T10:00:00.000Z'),
  attempts: 0,
};

describe('createStreamOutboxDispatcher', () => {
  it('writes a row as an envelope a consumer can decode', async () => {
    const commands = new MemoryStreamCommands();
    const dispatch = createStreamOutboxDispatcher(
      createStreamPublisher({ commands, key: KEY, maxLen: 100 }),
    );

    await dispatch(message);
    const [entry] = commands.entries(KEY);

    expect(decodeEnvelope(entry!)).toEqual({
      id: message.id,
      name: 'user.created',
      occurredAt: message.occurredAt,
      correlationId: 'corr-1',
      payload: message.payload,
    });
  });

  it('carries the row id across the transport unchanged', async () => {
    const commands = new MemoryStreamCommands();
    const dispatch = createStreamOutboxDispatcher(
      createStreamPublisher({ commands, key: KEY, maxLen: 100 }),
    );

    // Two at-least-once hops now sit between a request and a subscriber, and
    // both are answered by the same field: a redelivery is only recognisable if
    // the id does not move. An id minted per XADD would make the relay's own
    // retry look like a new event.
    await dispatch(message);
    await dispatch({ ...message, attempts: 1 });

    const ids = commands.entries(KEY).map((entry) => decodeEnvelope(entry).id);
    expect(ids).toEqual([message.id, message.id]);
  });

  it('publishes an event name this build has no subscriber for', async () => {
    const commands = new MemoryStreamCommands();
    const dispatch = createStreamOutboxDispatcher(
      createStreamPublisher({ commands, key: KEY, maxLen: 100 }),
    );

    // The bus dispatcher rejects an unknown name because publishing it locally
    // could not do anything. Writing it to a stream can: the consumer is a
    // different process, and during a rolling deploy it is frequently the newer
    // one. Filtering here would drop events the thing meant to handle them
    // understands perfectly.
    await expect(dispatch({ ...message, name: 'user.suspended' })).resolves.toBeUndefined();
    expect(decodeEnvelope(commands.entries(KEY)[0]!).name).toBe('user.suspended');
  });

  it('propagates an append failure so the row is not deleted', async () => {
    const failing = new MemoryStreamCommands();
    jest.spyOn(failing, 'append').mockRejectedValue(new Error('Connection is closed.'));

    const dispatch = createStreamOutboxDispatcher(
      createStreamPublisher({ commands: failing, key: KEY, maxLen: 100 }),
    );

    // The relay deletes a row when the dispatcher resolves. Swallowing this
    // would delete a row for an event that never reached the stream.
    await expect(dispatch(message)).rejects.toThrow('Connection is closed.');
  });
});
