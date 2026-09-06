import {
  MAGIC_LINK_DELIVERY_JOB,
  REDACTED,
  redactAppJobPayload,
} from '@/queue/jobs/app-jobs';

describe('redactAppJobPayload', () => {
  it('blanks the plaintext token on the magic link job', () => {
    const redacted = redactAppJobPayload(MAGIC_LINK_DELIVERY_JOB, {
      email: 'ada@example.test',
      token: 'not-a-real-token-0000',
      expiresAt: 1_757_160_000_000,
    });

    // A dead-letter record is the longest-lived copy of a payload in the
    // system: the source job is evicted by `removeOnFail` within hours and this
    // sits in `wait` until somebody reads it. A bearer credential must not be
    // the thing that outlives everything else.
    expect(redacted).toEqual({
      email: 'ada@example.test',
      token: REDACTED,
      expiresAt: 1_757_160_000_000,
    });
  });

  it('keeps the address, which is what makes the record useful', () => {
    const redacted = redactAppJobPayload(MAGIC_LINK_DELIVERY_JOB, {
      email: 'ada@example.test',
      token: 'not-a-real-token-0000',
      expiresAt: 1,
    }) as { email: string };

    expect(redacted.email).toBe('ada@example.test');
  });

  it('does not mutate the payload it was given', () => {
    const payload = { email: 'ada@example.test', token: 'not-a-real-token-0000', expiresAt: 1 };

    redactAppJobPayload(MAGIC_LINK_DELIVERY_JOB, payload);

    // The same object is still the live job's data — the sink runs after the
    // job has failed but on the instance the worker is holding.
    expect(payload.token).toBe('not-a-real-token-0000');
  });

  it('leaves other job names alone', () => {
    const payload = { reportId: 'r-1', token: 'this-one-is-not-a-credential' };

    // Per job name rather than "blank anything called `token`": the blanket
    // rule reads as safer and is not, because it fails silently the first time
    // somebody names a field `secret` or nests one a level down.
    expect(redactAppJobPayload('report.export', payload)).toBe(payload);
  });

  it('passes a non-object payload straight through', () => {
    expect(redactAppJobPayload(MAGIC_LINK_DELIVERY_JOB, null)).toBeNull();
    expect(redactAppJobPayload(MAGIC_LINK_DELIVERY_JOB, 'text')).toBe('text');
  });
});
