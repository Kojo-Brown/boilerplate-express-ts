import {
  isBusyGroupError,
  isNoGroupError,
  MalformedStreamEntryError,
  StreamHandlerTimeoutError,
  UnexpectedRedisReplyError,
} from '@/redis/redis.errors';

describe('isBusyGroupError', () => {
  it('recognises the reply an idempotent group creation gets', () => {
    // Verbatim from Redis 7. This predicate is the only thing standing between
    // "create the group if missing" and a crash on every boot after the first.
    expect(isBusyGroupError(new Error('BUSYGROUP Consumer Group name already exists'))).toBe(true);
  });

  it('does not match an error that merely mentions the word', () => {
    // Anchored, so an error quoting a group name containing "BUSYGROUP" is not
    // swallowed as an already-exists.
    expect(isBusyGroupError(new Error('ERR unknown group BUSYGROUP-ish'))).toBe(false);
  });

  it('is false for a non-error', () => {
    expect(isBusyGroupError('BUSYGROUP Consumer Group name already exists')).toBe(false);
    expect(isBusyGroupError(null)).toBe(false);
  });
});

describe('isNoGroupError', () => {
  it('recognises a missing key or group', () => {
    expect(
      isNoGroupError(
        new Error("NOGROUP No such key 'domain-events' or consumer group 'api-workers' in XREADGROUP with GROUP option"),
      ),
    ).toBe(true);
  });

  it('is false for an unrelated failure', () => {
    expect(isNoGroupError(new Error('Connection is closed.'))).toBe(false);
  });
});

describe('error shapes', () => {
  it('StreamHandlerTimeoutError names the entry and the budget', () => {
    const error = new StreamHandlerTimeoutError('1788526783579-0', 10_000);

    expect(error.name).toBe('StreamHandlerTimeoutError');
    expect(error.message).toContain('1788526783579-0');
    expect(error.message).toContain('10000ms');
    expect(error.entryId).toBe('1788526783579-0');
  });

  it('MalformedStreamEntryError carries the detail the producer needs', () => {
    const error = new MalformedStreamEntryError('1-1', 'name: Required');

    expect(error.name).toBe('MalformedStreamEntryError');
    expect(error.message).toContain('name: Required');
  });

  it('UnexpectedRedisReplyError names the command', () => {
    const error = new UnexpectedRedisReplyError('XPENDING', 'expected an array');

    expect(error.message).toBe('Unexpected XPENDING reply: expected an array');
    expect(error.command).toBe('XPENDING');
  });
});
