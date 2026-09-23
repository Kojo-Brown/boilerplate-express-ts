import { closePool } from '@/db/pool';
import { getFieldKeyring } from '@/crypto/field-encryption';
import { rotateUserPiiKeys } from '@/users/user-pii.rotation';

/**
 * `pnpm rotate:field-keys [batchSize] [maxPages]`
 *
 * Run after `FIELD_ENCRYPTION_ACTIVE_KEY_ID` has been pointed at a new key and
 * that deployment has reached every instance. Safe to run repeatedly, safe to
 * interrupt, and safe to run while the service is serving: a row is rewrapped
 * in one statement, and both keys are in the ring throughout.
 */

const batchSizeArg = process.argv[2];
const maxPagesArg = process.argv[3];

async function main(): Promise<void> {
  const keyring = getFieldKeyring();
  console.log(
    `[rotate-field-keys] Active key: ${keyring.activeKeyId} ` +
      `(ring holds: ${keyring.ids().join(', ')})`,
  );

  const result = await rotateUserPiiKeys({
    ...(batchSizeArg !== undefined ? { batchSize: parseInt(batchSizeArg, 10) } : {}),
    ...(maxPagesArg !== undefined ? { maxPages: parseInt(maxPagesArg, 10) } : {}),
    onPage: (progress) =>
      console.log(
        `[rotate-field-keys] page ${progress.page}: ` +
          `scanned ${progress.scanned}, rewrapped ${progress.rewrapped}`,
      ),
  });

  console.log(
    `[rotate-field-keys] ${result.complete ? 'Done' : 'Stopped at page limit'}: ` +
      `scanned ${result.scanned}, rewrapped ${result.rewrapped}` +
      (result.cursor === null ? '' : `, resume from ${result.cursor}`),
  );
}

main()
  .catch((err: unknown) => {
    console.error('[rotate-field-keys] Failed:', err);
    process.exitCode = 1;
  })
  // Without this the pool's idle clients hold the event loop open and the
  // script hangs after printing its summary.
  .finally(() => closePool());
