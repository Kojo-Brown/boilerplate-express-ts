import type { Queryable } from '@/db/queryable';
import { UserPiiRepository } from '@/users/user-pii.repository';

/**
 * Phase three of a key rotation: walk `user_pii` and re-wrap every data key
 * that still names a retired key under the active one.
 *
 * Phases one and two are deployments — add the new key to the ring everywhere,
 * then make it active. Until this pass has run, the old key cannot be removed
 * from the ring, because rows written before the switch still name it. That is
 * the sequence, and it is why the ring is a list rather than a key.
 *
 * Nothing here decrypts a field value. A data key is 32 bytes, so the work per
 * row is the same whether the address is twenty characters or two thousand.
 */

export interface RotationOptions {
  /** Rows per page. Each page is one `SELECT` plus one `UPDATE` per stale row. */
  readonly batchSize?: number;
  /**
   * A ceiling on pages, so a pass can be bounded when it runs beside traffic.
   * Reaching it is not an error: the cursor is returned, and the next run
   * resumes from it.
   */
  readonly maxPages?: number;
  /** Called after each page, for progress that is visible while it runs. */
  readonly onPage?: (progress: RotationProgress) => void;
}

export interface RotationProgress {
  readonly page: number;
  readonly scanned: number;
  readonly rewrapped: number;
  readonly cursor: string | null;
}

export interface RotationResult {
  readonly pages: number;
  readonly scanned: number;
  readonly rewrapped: number;
  /** `null` when the table was walked to the end; a cursor when `maxPages` cut it short. */
  readonly cursor: string | null;
  /** Whether every row was visited. */
  readonly complete: boolean;
}

const DEFAULT_BATCH_SIZE = 200;

/**
 * Deliberately not one transaction around the whole pass.
 *
 * A rotation over a table of any size would hold a snapshot open for the
 * duration, which blocks vacuum on every table in the database and risks the
 * whole thing rolling back at the last page. Each page's `UPDATE`s stand on
 * their own instead: a run that dies halfway has rewrapped what it rewrapped,
 * and the next run picks up the rest — safe precisely because a rewrapped row
 * and a stale row decrypt identically for as long as both keys are in the ring.
 */
export async function rotateUserPiiKeys(
  options: RotationOptions = {},
  tx?: Queryable,
  repository: UserPiiRepository = new UserPiiRepository(),
): Promise<RotationResult> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY;

  let cursor: string | null = null;
  let pages = 0;
  let scanned = 0;
  let rewrapped = 0;

  while (pages < maxPages) {
    const page = await repository.rewrapPage(cursor, batchSize, tx);
    pages += 1;
    scanned += page.scanned;
    rewrapped += page.rewrapped;
    cursor = page.nextCursor;
    options.onPage?.({ page: pages, scanned: page.scanned, rewrapped: page.rewrapped, cursor });
    if (cursor === null) break;
  }

  return { pages, scanned, rewrapped, cursor, complete: cursor === null };
}
