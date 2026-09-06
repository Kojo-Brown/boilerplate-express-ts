import { jobQueueConnection } from '@/queue/bull';

describe('jobQueueConnection', () => {
  it('hands BullMQ the URL to build its own connections from', () => {
    // Options rather than an ioredis instance, deliberately: a worker needs a
    // blocking connection whose `maxRetriesPerRequest` is `null`, and BullMQ
    // sets that only on the connections it creates itself. Handed an instance
    // it warns and carries on with a client that abandons a blocked command.
    expect(jobQueueConnection('redis://localhost:6379')).toEqual({
      url: 'redis://localhost:6379',
    });
  });

  it('refuses an empty URL rather than connecting to 127.0.0.1:6379', () => {
    // BullMQ's own default when no host is given is localhost, so an empty
    // `REDIS_URL` would produce a queue that connects somewhere plausible in
    // development and nowhere at all in production. `REDIS_URL` empty means the
    // subsystem is off, and this is where that is enforced.
    expect(() => jobQueueConnection('')).toThrow(/REDIS_URL is empty/);
  });
});
