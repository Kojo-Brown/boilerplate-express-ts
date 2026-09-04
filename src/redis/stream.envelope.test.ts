import { MalformedStreamEntryError } from '@/redis/redis.errors';
import { decodeEnvelope, encodeEnvelope, ENVELOPE_FIELDS } from '@/redis/stream.envelope';
import type { StreamEventEnvelope } from '@/redis/stream.envelope';

const envelope: StreamEventEnvelope = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'user.created',
  occurredAt: new Date('2026-09-04T10:11:12.000Z'),
  correlationId: 'corr-abc',
  payload: { userId: 'user-1', roles: ['admin'], actorId: null },
};

function entryOf(fields: Record<string, string>) {
  return { id: '1788526783579-0', fields };
}

describe('encodeEnvelope', () => {
  it('writes metadata as its own fields so XRANGE stays legible', () => {
    const fields = encodeEnvelope(envelope);

    expect(fields[ENVELOPE_FIELDS.name]).toBe('user.created');
    expect(fields[ENVELOPE_FIELDS.occurredAt]).toBe('2026-09-04T10:11:12.000Z');
    expect(fields[ENVELOPE_FIELDS.id]).toBe(envelope.id);
  });

  it('omits the correlation id rather than writing an empty string', () => {
    // Redis has no null. An empty value would come back as `''` and the decoder
    // could not tell "absent" from "the empty string".
    const fields = encodeEnvelope({ ...envelope, correlationId: null });

    expect(ENVELOPE_FIELDS.correlationId in fields).toBe(false);
  });

  it('keeps the payload as JSON so types survive', () => {
    const fields = encodeEnvelope({ ...envelope, payload: { count: 3, active: false } });

    expect(JSON.parse(fields[ENVELOPE_FIELDS.payload] ?? '')).toEqual({ count: 3, active: false });
  });
});

describe('decodeEnvelope', () => {
  it('round-trips an envelope', () => {
    expect(decodeEnvelope(entryOf(encodeEnvelope(envelope)))).toEqual(envelope);
  });

  it('round-trips one without a correlation id', () => {
    const without = { ...envelope, correlationId: null };

    expect(decodeEnvelope(entryOf(encodeEnvelope(without)))).toEqual(without);
  });

  it('keeps a numeric payload field numeric', () => {
    // The reason the payload is one JSON field rather than one field per key:
    // every stream field is a string, so `3` would come back `"3"` and `false`
    // would come back truthy.
    const fields = encodeEnvelope({ ...envelope, payload: { count: 3, active: false } });

    expect(decodeEnvelope(entryOf(fields)).payload).toEqual({ count: 3, active: false });
  });

  it('rejects an entry with no name', () => {
    const fields = encodeEnvelope(envelope);
    delete fields[ENVELOPE_FIELDS.name];

    expect(() => decodeEnvelope(entryOf(fields))).toThrow(MalformedStreamEntryError);
  });

  it('rejects an empty id, which is indistinguishable from an absent one on the wire', () => {
    expect(() =>
      decodeEnvelope(entryOf({ ...encodeEnvelope(envelope), [ENVELOPE_FIELDS.id]: '' })),
    ).toThrow(MalformedStreamEntryError);
  });

  it('rejects a timestamp that is not a date', () => {
    // Accepted, it becomes an Invalid Date whose `getTime()` is NaN — and the
    // failure lands in a subscriber, hours later, nowhere near the producer.
    expect(() =>
      decodeEnvelope(entryOf({ ...encodeEnvelope(envelope), [ENVELOPE_FIELDS.occurredAt]: 'yesterday' })),
    ).toThrow(MalformedStreamEntryError);
  });

  it('rejects a payload that is not JSON, naming the field', () => {
    expect(() =>
      decodeEnvelope(entryOf({ ...encodeEnvelope(envelope), [ENVELOPE_FIELDS.payload]: '{oops' })),
    ).toThrow(/data.*is not JSON/);
  });

  it('carries the entry id in the error so the producer is findable', () => {
    expect(() => decodeEnvelope(entryOf({}))).toThrow(/1788526783579-0/);
  });

  it('accepts a null payload', () => {
    const withNull = { ...envelope, payload: null };

    expect(decodeEnvelope(entryOf(encodeEnvelope(withNull))).payload).toBeNull();
  });
});
