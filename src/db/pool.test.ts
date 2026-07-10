import type { Pool } from 'pg';

const mockEnd = jest.fn().mockResolvedValue(undefined);
const mockOn = jest.fn();
const MockPool = jest.fn(() => ({ end: mockEnd, on: mockOn }));

jest.mock('pg', () => ({ Pool: MockPool }));
jest.mock('@/config/env', () => ({
  env: {
    DATABASE_URL: 'postgresql://user:password@localhost:5432/testdb',
    NODE_ENV: 'test',
  },
}));

describe('getPool', () => {
  let getPool: () => Pool;
  let closePool: () => Promise<void>;

  beforeEach(() => {
    MockPool.mockClear();
    mockEnd.mockClear();
    mockOn.mockClear();
    jest.isolateModules(() => {
      const db = require('@/db/pool') as typeof import('@/db/pool');
      getPool = db.getPool;
      closePool = db.closePool;
    });
  });

  it('creates a Pool with the DATABASE_URL connection string', () => {
    getPool();
    expect(MockPool).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionString: 'postgresql://user:password@localhost:5432/testdb',
      }),
    );
  });

  it('configures the pool with sensible defaults', () => {
    getPool();
    expect(MockPool).toHaveBeenCalledWith(
      expect.objectContaining({
        max: 20,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
      }),
    );
  });

  it('returns the same instance on repeated calls (singleton)', () => {
    const first = getPool();
    const second = getPool();
    expect(first).toBe(second);
    expect(MockPool).toHaveBeenCalledTimes(1);
  });

  it('registers an error listener on the pool', () => {
    getPool();
    expect(mockOn).toHaveBeenCalledWith('error', expect.any(Function));
  });

  describe('closePool', () => {
    it('calls end() on the active pool', async () => {
      getPool();
      await closePool();
      expect(mockEnd).toHaveBeenCalledTimes(1);
    });

    it('sets the singleton to null so a new pool is created on next call', async () => {
      getPool();
      await closePool();
      getPool();
      expect(MockPool).toHaveBeenCalledTimes(2);
    });

    it('is safe to call when no pool exists', async () => {
      await expect(closePool()).resolves.toBeUndefined();
      expect(mockEnd).not.toHaveBeenCalled();
    });
  });
});
