import path from 'path';
import { runner } from 'node-pg-migrate';
import type { RunnerOption } from 'node-pg-migrate';
import { env } from '@/config/env';

export const DEFAULT_MIGRATIONS_DIR = path.join(process.cwd(), 'migrations');
export const MIGRATIONS_TABLE = 'pgmigrations';

export interface MigrateOptions {
  direction?: 'up' | 'down';
  count?: number;
  databaseUrl?: string;
  migrationsDir?: string;
  verbose?: boolean;
}

export async function runMigrations(options: MigrateOptions = {}): Promise<void> {
  const {
    direction = 'up',
    count,
    databaseUrl = env.DATABASE_URL,
    migrationsDir = DEFAULT_MIGRATIONS_DIR,
    verbose = false,
  } = options;

  const runnerOptions: RunnerOption = {
    databaseUrl,
    migrationsTable: MIGRATIONS_TABLE,
    direction,
    dir: migrationsDir,
    verbose,
    ...(count !== undefined && { count }),
  };

  await runner(runnerOptions);
}
