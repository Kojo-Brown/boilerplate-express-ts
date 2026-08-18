import { lockingClause } from '@/db/locking';
import type { RowLockStrength, RowLockWait } from '@/db/locking';

describe('lockingClause', () => {
  it('defaults to FOR UPDATE with an unbounded wait', () => {
    expect(lockingClause()).toBe('FOR UPDATE');
    expect(lockingClause({})).toBe('FOR UPDATE');
  });

  it.each<[RowLockStrength, string]>([
    ['update', 'FOR UPDATE'],
    ['no key update', 'FOR NO KEY UPDATE'],
    ['share', 'FOR SHARE'],
    ['key share', 'FOR KEY SHARE'],
  ])('renders %s', (strength, expected) => {
    expect(lockingClause({ strength })).toBe(expected);
  });

  it.each<[RowLockWait, string]>([
    ['wait', 'FOR UPDATE'],
    ['nowait', 'FOR UPDATE NOWAIT'],
    ['skip locked', 'FOR UPDATE SKIP LOCKED'],
  ])('renders the %s policy', (wait, expected) => {
    expect(lockingClause({ wait })).toBe(expected);
  });

  it('combines strength and wait policy', () => {
    expect(lockingClause({ strength: 'no key update', wait: 'nowait' })).toBe(
      'FOR NO KEY UPDATE NOWAIT',
    );
    expect(lockingClause({ strength: 'share', wait: 'skip locked' })).toBe(
      'FOR SHARE SKIP LOCKED',
    );
  });

  /**
   * The clause is concatenated into SQL as text, which is only safe while both
   * inputs come from closed unions and neither is echoed. Asserting the output
   * alphabet is what keeps that true if somebody widens the types later.
   */
  it('produces nothing outside the SQL keywords it is built from', () => {
    const strengths: RowLockStrength[] = ['update', 'no key update', 'share', 'key share'];
    const waits: RowLockWait[] = ['wait', 'nowait', 'skip locked'];

    for (const strength of strengths) {
      for (const wait of waits) {
        expect(lockingClause({ strength, wait })).toMatch(/^[A-Z ]+$/);
      }
    }
  });
});
