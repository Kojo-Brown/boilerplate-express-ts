const mockQuery = jest.fn();
const mockQueryOne = jest.fn();
const mockQueryCount = jest.fn();

jest.mock('@/db/query', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
  queryCount: (...args: unknown[]) => mockQueryCount(...args),
  poolQueryable: {
    query: (...args: unknown[]) => mockQuery(...args),
    queryOne: (...args: unknown[]) => mockQueryOne(...args),
    queryCount: (...args: unknown[]) => mockQueryCount(...args),
  },
}));

import { randomBytes } from 'node:crypto';
import { FieldDecryptionError, createFieldCipher } from '@/crypto/field-cipher';
import { parseKeyring } from '@/crypto/keyring';
import {
  ADDRESS_COLUMN,
  PHONE_COLUMN,
  USER_PII_TABLE,
  UserPiiRepository,
} from '@/users/user-pii.repository';
import type { UserPiiRow } from '@/users/user-pii.repository';
import { rotateUserPiiKeys } from '@/users/user-pii.rotation';

const KEY_1 = randomBytes(32).toString('base64');
const KEY_2 = randomBytes(32).toString('base64');

/** Before a rotation: one key, and it is active. */
const currentCipher = createFieldCipher(parseKeyring(`k1:${KEY_1}`, 'k1'));
/** After phase two: both keys held, new writes under `k2`. */
const rotatedCipher = createFieldCipher(parseKeyring(`k1:${KEY_1},k2:${KEY_2}`, 'k2'));

const repo = new UserPiiRepository(currentCipher);
const rotatingRepo = new UserPiiRepository(rotatedCipher);

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

const PHONE = '+15550000000';
const ADDRESS = '1 Fake Street, Nowhere';

function row(overrides: Partial<UserPiiRow> & Pick<UserPiiRow, 'id'>): UserPiiRow {
  return {
    phone_encrypted: null,
    address_encrypted: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

/** A stored value, as the column would hold it. */
function stored(
  cipher: typeof currentCipher,
  userId: string,
  column: string,
  value: string,
): Buffer {
  return cipher.encrypt(value, { table: USER_PII_TABLE, column, id: userId });
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQueryOne.mockReset();
  mockQueryCount.mockReset();
});

describe('UserPiiRepository.findPii', () => {
  it('decrypts both columns', async () => {
    mockQueryOne.mockResolvedValue(
      row({
        id: USER_A,
        phone_encrypted: stored(currentCipher, USER_A, PHONE_COLUMN, PHONE),
        address_encrypted: stored(currentCipher, USER_A, ADDRESS_COLUMN, ADDRESS),
      }),
    );

    await expect(repo.findPii(USER_A)).resolves.toEqual({
      userId: USER_A,
      phone: PHONE,
      address: ADDRESS,
    });
    expect(mockQueryOne).toHaveBeenCalledWith(`SELECT * FROM "${USER_PII_TABLE}" WHERE id = $1`, [
      USER_A,
    ]);
  });

  it('leaves absent fields null rather than decrypting nothing', async () => {
    mockQueryOne.mockResolvedValue(
      row({ id: USER_A, phone_encrypted: stored(currentCipher, USER_A, PHONE_COLUMN, PHONE) }),
    );

    await expect(repo.findPii(USER_A)).resolves.toEqual({
      userId: USER_A,
      phone: PHONE,
      address: null,
    });
  });

  it('returns null for a user with no row', async () => {
    mockQueryOne.mockResolvedValue(null);
    await expect(repo.findPii(USER_A)).resolves.toBeNull();
  });

  it('refuses a row whose ciphertext was written for another user', async () => {
    // The end-to-end version of the substitution the context prevents: someone
    // with write access to the database moves user A's encrypted phone number
    // into user B's row. Unbound, this read would return A's number as B's,
    // with nothing anywhere reporting a problem.
    mockQueryOne.mockResolvedValue(
      row({ id: USER_B, phone_encrypted: stored(currentCipher, USER_A, PHONE_COLUMN, PHONE) }),
    );

    await expect(repo.findPii(USER_B)).rejects.toThrow(FieldDecryptionError);
  });

  it('refuses a value moved between columns of the same row', async () => {
    mockQueryOne.mockResolvedValue(
      row({ id: USER_A, address_encrypted: stored(currentCipher, USER_A, PHONE_COLUMN, PHONE) }),
    );

    await expect(repo.findPii(USER_A)).rejects.toThrow(FieldDecryptionError);
  });
});

describe('UserPiiRepository.savePii', () => {
  it('sends ciphertext, and ciphertext that only opens in this row', async () => {
    mockQueryOne.mockImplementation((_sql: string, params: unknown[]) =>
      Promise.resolve(row({ id: USER_A, phone_encrypted: params[1] as Buffer })),
    );

    await expect(repo.savePii(USER_A, { phone: PHONE })).resolves.toEqual({
      userId: USER_A,
      phone: PHONE,
      address: null,
    });

    const params = mockQueryOne.mock.calls[0]?.[1] as unknown[];
    const sentPhone = params[1] as Buffer;
    expect(Buffer.isBuffer(sentPhone)).toBe(true);
    expect(sentPhone.includes(Buffer.from(PHONE, 'utf8'))).toBe(false);
    expect(
      currentCipher.decryptText(sentPhone, {
        table: USER_PII_TABLE,
        column: PHONE_COLUMN,
        id: USER_A,
      }),
    ).toBe(PHONE);
    // Bound to this row and this column, in the bytes that were about to be
    // written — not merely at the point they are read back.
    expect(() =>
      currentCipher.decryptText(sentPhone, {
        table: USER_PII_TABLE,
        column: PHONE_COLUMN,
        id: USER_B,
      }),
    ).toThrow(FieldDecryptionError);
  });

  it('upserts, so a first save and a later one are the same statement', async () => {
    mockQueryOne.mockResolvedValue(row({ id: USER_A }));
    await repo.savePii(USER_A, { phone: PHONE });

    const sql = mockQueryOne.mock.calls[0]?.[0] as string;
    expect(sql).toContain(`INSERT INTO "${USER_PII_TABLE}"`);
    expect(sql).toContain('ON CONFLICT ("id") DO UPDATE SET');
  });

  it('leaves an unmentioned field alone', async () => {
    mockQueryOne.mockResolvedValue(row({ id: USER_A }));
    await repo.savePii(USER_A, { phone: PHONE });

    const sql = mockQueryOne.mock.calls[0]?.[0] as string;
    const params = mockQueryOne.mock.calls[0]?.[1] as unknown[];
    expect(sql).toContain(
      `"${ADDRESS_COLUMN}" = COALESCE(EXCLUDED."${ADDRESS_COLUMN}", "${USER_PII_TABLE}"."${ADDRESS_COLUMN}")`,
    );
    expect(params[2]).toBeNull();
  });

  it('clears a field the caller explicitly nulled', async () => {
    // The distinction `undefined`-means-both would lose: a partial save that
    // did not mention the address must not erase it, and an erasure request
    // must not be silently ignored.
    mockQueryOne.mockResolvedValue(row({ id: USER_A }));
    await repo.savePii(USER_A, { phone: PHONE, address: null });

    const sql = mockQueryOne.mock.calls[0]?.[0] as string;
    expect(sql).toContain(`"${ADDRESS_COLUMN}" = NULL`);
    expect(sql).not.toContain(`COALESCE(EXCLUDED."${ADDRESS_COLUMN}"`);
  });

  it('bumps updated_at on the conflict branch', async () => {
    mockQueryOne.mockResolvedValue(row({ id: USER_A }));
    await repo.savePii(USER_A, { phone: PHONE });

    expect(mockQueryOne.mock.calls[0]?.[0]).toContain('"updated_at" = NOW()');
  });

  it('throws rather than reporting a write it cannot see', async () => {
    mockQueryOne.mockResolvedValue(null);
    await expect(repo.savePii(USER_A, { phone: PHONE })).rejects.toThrow(/returned no rows/);
  });
});

describe('UserPiiRepository.rewrapPage', () => {
  it('re-wraps stale rows and skips rows already on the active key', async () => {
    const stale = stored(currentCipher, USER_A, PHONE_COLUMN, PHONE);
    const fresh = stored(rotatedCipher, USER_B, PHONE_COLUMN, PHONE);
    mockQuery.mockResolvedValue([
      row({ id: USER_A, phone_encrypted: stale }),
      row({ id: USER_B, phone_encrypted: fresh }),
    ]);
    mockQueryOne.mockResolvedValue(null);

    const page = await rotatingRepo.rewrapPage(null, 10);

    expect(page).toEqual({ scanned: 2, rewrapped: 1, nextCursor: null });
    expect(mockQueryOne).toHaveBeenCalledTimes(1);

    const params = mockQueryOne.mock.calls[0]?.[1] as unknown[];
    const rewrapped = params[0] as Buffer;
    // The value survives the rewrap, and the payload is carried across rather
    // than re-encrypted: the wrap is new, the ciphertext is the same bytes.
    expect(
      rotatedCipher.decryptText(rewrapped, {
        table: USER_PII_TABLE,
        column: PHONE_COLUMN,
        id: USER_A,
      }),
    ).toBe(PHONE);
    expect(rotatedCipher.needsRewrap(rewrapped)).toBe(false);
    expect(rewrapped).toHaveLength(stale.length);
  });

  it('re-wraps every encrypted column of a row in one update', async () => {
    mockQuery.mockResolvedValue([
      row({
        id: USER_A,
        phone_encrypted: stored(currentCipher, USER_A, PHONE_COLUMN, PHONE),
        address_encrypted: stored(currentCipher, USER_A, ADDRESS_COLUMN, ADDRESS),
      }),
    ]);
    mockQueryOne.mockResolvedValue(null);

    await expect(rotatingRepo.rewrapPage(null, 10)).resolves.toMatchObject({ rewrapped: 1 });

    expect(mockQueryOne).toHaveBeenCalledTimes(1);
    const sql = mockQueryOne.mock.calls[0]?.[0] as string;
    expect(sql).toContain(`"${PHONE_COLUMN}" = $1`);
    expect(sql).toContain(`"${ADDRESS_COLUMN}" = $2`);
  });

  it('writes nothing when a page is already rotated', async () => {
    mockQuery.mockResolvedValue([
      row({ id: USER_A, phone_encrypted: stored(rotatedCipher, USER_A, PHONE_COLUMN, PHONE) }),
      row({ id: USER_B }),
    ]);

    await expect(rotatingRepo.rewrapPage(null, 10)).resolves.toEqual({
      scanned: 2,
      rewrapped: 0,
      nextCursor: null,
    });
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  it('pages by cursor, not offset', async () => {
    mockQuery.mockResolvedValue([row({ id: USER_A }), row({ id: USER_B })]);

    const page = await rotatingRepo.rewrapPage(null, 2);

    // A full page hands back the last id, so the next call resumes after it.
    // With `OFFSET` instead, rows inserted mid-pass would shift the boundary
    // and rows would be visited twice or not at all.
    expect(page.nextCursor).toBe(USER_B);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('"id" > $1::uuid');
    expect(sql).not.toContain('OFFSET');
    expect(params).toEqual([null, 2]);

    mockQuery.mockResolvedValue([]);
    await rotatingRepo.rewrapPage(page.nextCursor, 2);
    expect(mockQuery.mock.calls[1]?.[1]).toEqual([USER_B, 2]);
  });

  it('rejects a limit that would make the scan meaningless', async () => {
    await expect(rotatingRepo.rewrapPage(null, 0)).rejects.toThrow(RangeError);
    await expect(rotatingRepo.rewrapPage(null, 1.5)).rejects.toThrow(RangeError);
  });
});

describe('rotateUserPiiKeys', () => {
  it('walks every page until the table ends', async () => {
    const pages = [
      { scanned: 2, rewrapped: 2, nextCursor: USER_A },
      { scanned: 2, rewrapped: 1, nextCursor: USER_B },
      { scanned: 1, rewrapped: 0, nextCursor: null },
    ];
    const rewrapPage = jest.fn().mockImplementation(() => Promise.resolve(pages.shift()));
    const fake = { rewrapPage } as unknown as UserPiiRepository;

    const seen: number[] = [];
    const result = await rotateUserPiiKeys(
      { batchSize: 2, onPage: (progress) => seen.push(progress.page) },
      undefined,
      fake,
    );

    expect(result).toEqual({ pages: 3, scanned: 5, rewrapped: 3, cursor: null, complete: true });
    expect(seen).toEqual([1, 2, 3]);
    expect(rewrapPage).toHaveBeenNthCalledWith(1, null, 2, undefined);
    expect(rewrapPage).toHaveBeenNthCalledWith(2, USER_A, 2, undefined);
  });

  it('stops at the page limit and reports where to resume', async () => {
    // A bounded pass is how this runs beside live traffic: stop, let the
    // service breathe, start again from the cursor. Not an error — an
    // interrupted rotation is a correct half-rotated table, because both keys
    // are in the ring until the third deployment retires the old one.
    const rewrapPage = jest
      .fn()
      .mockResolvedValue({ scanned: 2, rewrapped: 2, nextCursor: USER_B });
    const fake = { rewrapPage } as unknown as UserPiiRepository;

    const result = await rotateUserPiiKeys({ batchSize: 2, maxPages: 2 }, undefined, fake);

    expect(result).toEqual({
      pages: 2,
      scanned: 4,
      rewrapped: 4,
      cursor: USER_B,
      complete: false,
    });
    expect(rewrapPage).toHaveBeenCalledTimes(2);
  });

  it('rotates a table end to end through the repository', async () => {
    // The pieces together: rows written under the old key, one pass, every row
    // readable by the new ring and none of them still naming the old key.
    const table = new Map<string, Buffer>([
      [USER_A, stored(currentCipher, USER_A, PHONE_COLUMN, PHONE)],
      [USER_B, stored(currentCipher, USER_B, PHONE_COLUMN, ADDRESS)],
    ]);

    mockQuery.mockImplementation((_sql: string, params: unknown[]) => {
      const cursor = params[0] as string | null;
      const limit = params[1] as number;
      const ids = [...table.keys()].sort().filter((id) => cursor === null || id > cursor);
      return Promise.resolve(
        ids.slice(0, limit).map((id) => row({ id, phone_encrypted: table.get(id) ?? null })),
      );
    });
    mockQueryOne.mockImplementation((_sql: string, params: unknown[]) => {
      table.set(params[1] as string, params[0] as Buffer);
      return Promise.resolve(null);
    });

    const result = await rotateUserPiiKeys({ batchSize: 1 }, undefined, rotatingRepo);

    expect(result.rewrapped).toBe(2);
    expect(result.complete).toBe(true);
    for (const [id, value] of table) {
      expect(rotatedCipher.needsRewrap(value)).toBe(false);
      expect(
        rotatedCipher.decryptText(value, {
          table: USER_PII_TABLE,
          column: PHONE_COLUMN,
          id,
        }),
      ).toBe(id === USER_A ? PHONE : ADDRESS);
    }
  });
});
