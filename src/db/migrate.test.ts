const mockRunner = jest.fn().mockResolvedValue([]);

jest.mock('node-pg-migrate', () => ({
  runner: mockRunner,
}));

jest.mock('@/config/env', () => ({
  env: {
    DATABASE_URL: 'postgresql://user:password@localhost:5432/testdb',
    NODE_ENV: 'test',
  },
}));

import { runMigrations, MIGRATIONS_TABLE, DEFAULT_MIGRATIONS_DIR } from '@/db/migrate';

beforeEach(() => {
  mockRunner.mockClear();
});

describe('runMigrations', () => {
  it('runs up migrations by default', async () => {
    await runMigrations();
    expect(mockRunner).toHaveBeenCalledWith(
      expect.objectContaining({ direction: 'up' }),
    );
  });

  it('uses DATABASE_URL from env by default', async () => {
    await runMigrations();
    expect(mockRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        databaseUrl: 'postgresql://user:password@localhost:5432/testdb',
      }),
    );
  });

  it('uses the configured migrations table', async () => {
    await runMigrations();
    expect(mockRunner).toHaveBeenCalledWith(
      expect.objectContaining({ migrationsTable: MIGRATIONS_TABLE }),
    );
  });

  it('uses the default migrations directory', async () => {
    await runMigrations();
    expect(mockRunner).toHaveBeenCalledWith(
      expect.objectContaining({ dir: DEFAULT_MIGRATIONS_DIR }),
    );
  });

  it('runs down migrations when direction is "down"', async () => {
    await runMigrations({ direction: 'down' });
    expect(mockRunner).toHaveBeenCalledWith(
      expect.objectContaining({ direction: 'down' }),
    );
  });

  it('passes count when provided', async () => {
    await runMigrations({ count: 1 });
    expect(mockRunner).toHaveBeenCalledWith(
      expect.objectContaining({ count: 1 }),
    );
  });

  it('does not include count in options when not provided', async () => {
    await runMigrations();
    const call = mockRunner.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call).not.toHaveProperty('count');
  });

  it('accepts a custom databaseUrl', async () => {
    const customUrl = 'postgresql://other:pass@host:5432/db';
    await runMigrations({ databaseUrl: customUrl });
    expect(mockRunner).toHaveBeenCalledWith(
      expect.objectContaining({ databaseUrl: customUrl }),
    );
  });

  it('accepts a custom migrationsDir', async () => {
    const customDir = '/tmp/custom-migrations';
    await runMigrations({ migrationsDir: customDir });
    expect(mockRunner).toHaveBeenCalledWith(
      expect.objectContaining({ dir: customDir }),
    );
  });

  it('sets verbose to false by default', async () => {
    await runMigrations();
    expect(mockRunner).toHaveBeenCalledWith(
      expect.objectContaining({ verbose: false }),
    );
  });

  it('passes verbose: true when requested', async () => {
    await runMigrations({ verbose: true });
    expect(mockRunner).toHaveBeenCalledWith(
      expect.objectContaining({ verbose: true }),
    );
  });

  it('propagates errors from the runner', async () => {
    mockRunner.mockRejectedValueOnce(new Error('Connection refused'));
    await expect(runMigrations()).rejects.toThrow('Connection refused');
  });
});
