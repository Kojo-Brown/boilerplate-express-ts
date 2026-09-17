import { createPostgresCheck, POSTGRES_PING_SQL } from '@/health/checks/postgres.check';
import type { HealthPool, HealthPoolClient } from '@/health/checks/postgres.check';
import { runCheck } from '@/health/run-check';

interface FakeClient extends HealthPoolClient {
  readonly queries: string[];
  readonly releases: (Error | boolean | undefined)[];
}

function fakeClient(query: (text: string) => Promise<unknown> = () => Promise.resolve()): FakeClient {
  const queries: string[] = [];
  const releases: (Error | boolean | undefined)[] = [];

  return {
    queries,
    releases,
    query(text: string): Promise<unknown> {
      queries.push(text);
      return query(text);
    },
    release(destroy?: Error | boolean): void {
      if (releases.length > 0) throw new Error('release called twice on one client');
      releases.push(destroy);
    },
  };
}

function poolOf(connect: () => Promise<HealthPoolClient>): HealthPool {
  return { connect };
}

const never = new AbortController().signal;

describe('createPostgresCheck', () => {
  it('is critical by default, because no route works without it', () => {
    const check = createPostgresCheck({ pool: () => poolOf(() => Promise.resolve(fakeClient())) });
    expect(check).toMatchObject({ name: 'postgres', criticality: 'critical' });
  });

  it('asks the cheapest question that still proves the whole path', async () => {
    const client = fakeClient();
    const check = createPostgresCheck({ pool: () => poolOf(() => Promise.resolve(client)) });

    await check.run(never);

    expect(client.queries).toEqual([POSTGRES_PING_SQL]);
    // Returned to the pool, not destroyed: this connection is known good and
    // throwing it away would make the probe a connection-churn generator.
    expect(client.releases).toEqual([undefined]);
  });

  it('goes through the pool the application itself uses', async () => {
    // A dedicated connection would report `ok` while the pool is exhausted and
    // this instance can serve nothing — a green readiness probe during an
    // outage, which is the failure the split is supposed to prevent.
    let connects = 0;
    const check = createPostgresCheck({
      pool: () =>
        poolOf(() => {
          connects += 1;
          return Promise.resolve(fakeClient());
        }),
    });

    await check.run(never);
    await check.run(never);

    expect(connects).toBe(2);
  });

  it('resolves the pool lazily, so registration does not open one', () => {
    let resolved = false;
    createPostgresCheck({
      pool: () => {
        resolved = true;
        return poolOf(() => Promise.resolve(fakeClient()));
      },
    });

    expect(resolved).toBe(false);
  });

  it('destroys the client when the ping fails, rather than returning it', async () => {
    // Its state on the wire is unknown — returning it hands the next caller a
    // connection that may still deliver a result it did not ask for.
    const failure = new Error('terminating connection due to administrator command');
    const client = fakeClient(() => Promise.reject(failure));
    const check = createPostgresCheck({ pool: () => poolOf(() => Promise.resolve(client)) });

    await expect(check.run(never)).rejects.toThrow(failure);
    expect(client.releases).toEqual([failure]);
  });

  it('surfaces a failed connect as a failed check', async () => {
    const check = createPostgresCheck({
      pool: () => poolOf(() => Promise.reject(new Error('ECONNREFUSED'))),
    });

    const result = await runCheck(check, { timeoutMs: 100 });
    expect(result).toMatchObject({ name: 'postgres', status: 'failed' });
    expect(result.error).toContain('ECONNREFUSED');
  });

  describe('when the deadline expires first', () => {
    it('gives back the client that arrives after the check has been abandoned', async () => {
      // `pool.connect()` cannot be withdrawn, so the client turns up for a check
      // nobody is waiting on any more. Unreleased, that is one pool slot gone
      // for the life of the process, per timed-out probe — during the incident
      // where slots are the scarce thing.
      const client = fakeClient();
      let handOver!: () => void;
      const queued = new Promise<void>((resolve) => {
        handOver = resolve;
      });

      const check = createPostgresCheck({
        pool: () => poolOf(async () => {
          await queued;
          return client;
        }),
      });

      const result = await runCheck(check, { timeoutMs: 20 });
      expect(result.status).toBe('failed');
      expect(result.error).toContain('did not answer within 20ms');

      handOver();
      await new Promise((resolve) => setImmediate(resolve));

      // Destroyed rather than returned: it was acquired for a request that no
      // longer exists, and `true` is `pg`'s own way of saying so.
      expect(client.releases).toEqual([true]);
      expect(client.queries).toEqual([]);
    });

    it('destroys a client whose ping outlived the deadline', async () => {
      const client = fakeClient(
        () =>
          new Promise((resolve) => {
            setTimeout(resolve, 40);
          }),
      );
      const check = createPostgresCheck({ pool: () => poolOf(() => Promise.resolve(client)) });

      const result = await runCheck(check, { timeoutMs: 20 });
      expect(result.status).toBe('failed');

      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(client.releases).toEqual([true]);
    });

    it('releases exactly once on every path', async () => {
      // `fakeClient` throws on a second release, which is what `pg` does. The
      // two paths above are the ones where a double release is easy to write:
      // the late-arrival handler and the body both hold the same client.
      const client = fakeClient();
      const check = createPostgresCheck({ pool: () => poolOf(() => Promise.resolve(client)) });

      await check.run(never);
      await new Promise((resolve) => setImmediate(resolve));

      expect(client.releases).toHaveLength(1);
    });
  });
});
