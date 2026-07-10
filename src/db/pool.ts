import { Pool } from 'pg';
import type { PoolConfig } from 'pg';
import { env } from '@/config/env';

let _pool: Pool | null = null;

export function getPool(): Pool {
  if (_pool) return _pool;

  const config: PoolConfig = {
    connectionString: env.DATABASE_URL,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  };

  _pool = new Pool(config);

  _pool.on('error', (err: Error) => {
    console.error('[pg pool] Unexpected idle client error:', err);
  });

  return _pool;
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
