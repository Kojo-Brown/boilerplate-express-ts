import { createParkingLot, PARK_FIELDS, parkedStreamKey } from '@/redis/parking-lot';
import { decodeEnvelope, encodeEnvelope } from '@/redis/stream.envelope';
import { MemoryStreamCommands } from '@/redis/stream.memory';

const KEY = 'test-events';

const fields = encodeEnvelope({
  id: 'event-1',
  name: 'user.created',
  occurredAt: new Date('2026-09-04T10:00:00.000Z'),
  correlationId: null,
  payload: { userId: 'user-1' },
});

describe('createParkingLot', () => {
  it('writes to the companion stream', async () => {
    const commands = new MemoryStreamCommands();
    const park = createParkingLot({ commands, key: KEY });

    await park({
      entry: { id: '1788526783579-0', fields },
      reason: 'delivery-ceiling',
      lastError: 'Error: subscriber down',
      deliveryCount: 5,
    });

    expect(commands.entries(parkedStreamKey(KEY))).toHaveLength(1);
    expect(commands.entries(KEY)).toHaveLength(0);
  });

  it('keeps the original fields intact so the entry can be replayed', async () => {
    const commands = new MemoryStreamCommands();
    const park = createParkingLot({ commands, key: KEY, now: () => new Date('2026-09-04T11:00:00.000Z') });

    await park({
      entry: { id: '1788526783579-0', fields },
      reason: 'delivery-ceiling',
      lastError: 'Error: subscriber down',
      deliveryCount: 5,
    });

    const [parked] = commands.entries(parkedStreamKey(KEY));

    // The replay is an XADD of these fields back onto the source, which only
    // works because they were stored beside the metadata rather than nested
    // inside it.
    expect(decodeEnvelope({ id: 'ignored', fields: parked!.fields }).id).toBe('event-1');
    expect(parked!.fields[PARK_FIELDS.reason]).toBe('delivery-ceiling');
    expect(parked!.fields[PARK_FIELDS.lastError]).toBe('Error: subscriber down');
    expect(parked!.fields[PARK_FIELDS.deliveryCount]).toBe('5');
    expect(parked!.fields[PARK_FIELDS.sourceStream]).toBe(KEY);
    // The parked entry gets a new id, so without this there is no way back to
    // the pending-list history that explains how it got here.
    expect(parked!.fields[PARK_FIELDS.sourceEntryId]).toBe('1788526783579-0');
    expect(parked!.fields[PARK_FIELDS.parkedAt]).toBe('2026-09-04T11:00:00.000Z');
  });

  it('caps the parked stream too', async () => {
    const commands = new MemoryStreamCommands();
    const park = createParkingLot({ commands, key: KEY, maxLen: 2 });

    for (let i = 0; i < 5; i += 1) {
      await park({
        entry: { id: `1788526783579-${i}`, fields },
        reason: 'undecodable',
        lastError: 'MalformedStreamEntryError: nope',
        deliveryCount: 1,
      });
    }

    // A producer emitting malformed entries in a loop would otherwise fill the
    // instance with the evidence of it.
    expect(commands.entries(parkedStreamKey(KEY))).toHaveLength(2);
  });
});
