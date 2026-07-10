import { runMigrations } from '@/db/migrate';

const rawDirection = process.argv[2];
const direction: 'up' | 'down' = rawDirection === 'down' ? 'down' : 'up';
const rawCount = process.argv[3];
const count = rawCount !== undefined ? parseInt(rawCount, 10) : undefined;

async function main(): Promise<void> {
  const label = count !== undefined ? `${direction} (count: ${count})` : direction;
  console.log(`[migrate] Running migrations: ${label}`);
  await runMigrations({ direction, count, verbose: true });
  console.log('[migrate] Done.');
}

main().catch((err: unknown) => {
  console.error('[migrate] Failed:', err);
  process.exit(1);
});
