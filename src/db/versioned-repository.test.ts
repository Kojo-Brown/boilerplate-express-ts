const mockQuery = jest.fn();
const mockQueryOne = jest.fn();
const mockQueryCount = jest.fn();

jest.mock('@/db/query', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
  queryCount: (...args: unknown[]) => mockQueryCount(...args),
}));

import { VersionedRepository } from '@/db/versioned-repository';
import type { VersionedRow } from '@/db/versioned-repository';
import { ANY_VERSION } from '@/concurrency/concurrency.types';

interface DocRow extends VersionedRow {
  id: string;
  title: string;
  created_at: Date;
  updated_at: Date;
  version: number;
}

type DocInsert = { title: string };
type DocUpdate = { title?: string; version?: number };

class DocRepository extends VersionedRepository<DocRow, DocInsert, DocUpdate> {
  protected override readonly tableName = 'docs';
}

class NoTimestampsDocRepository extends VersionedRepository<DocRow, DocInsert, DocUpdate> {
  protected override readonly tableName = 'notes';
  protected override readonly hasTimestamps = false;
}

const repo = new DocRepository();
const noTsRepo = new NoTimestampsDocRepository();

const DOC: DocRow = {
  id: 'doc-1',
  title: 'A title',
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-02T00:00:00Z'),
  version: 4,
};

/** The last statement issued, with whitespace collapsed so it can be asserted on. */
function lastSql(): string {
  const [sql] = mockQueryOne.mock.calls.at(-1) as [string, unknown[]];
  return sql.replace(/\s+/g, ' ').trim();
}

function lastParams(): unknown[] {
  const [, params] = mockQueryOne.mock.calls.at(-1) as [string, unknown[]];
  return params;
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQueryOne.mockReset();
  mockQueryCount.mockReset();
});

describe('VersionedRepository.updateWithVersion: the statement', () => {
  it('constrains the update to the versions the caller named', async () => {
    mockQueryOne.mockResolvedValue({ ...DOC, __updated: true });

    await repo.updateWithVersion('doc-1', { title: 'New' }, { kind: 'versions', versions: [3, 4] });

    expect(lastSql()).toContain('"version" = ANY($3::int[])');
    expect(lastParams()).toEqual(['New', 'doc-1', [3, 4]]);
  });

  it('adds no version predicate for a wildcard precondition', async () => {
    mockQueryOne.mockResolvedValue({ ...DOC, __updated: true });

    await repo.updateWithVersion('doc-1', { title: 'New' }, ANY_VERSION);

    expect(lastSql()).not.toContain('ANY(');
    expect(lastSql()).toContain('WHERE "id" = $2');
    expect(lastParams()).toEqual(['New', 'doc-1']);
  });

  it('passes an empty version set through, because it correctly matches nothing', async () => {
    // This is what a header of only unmatchable tags — `If-Match: "abc"` —
    // reduces to. Short-circuiting it here would skip the statement that tells
    // 404 apart from 412.
    mockQueryOne.mockResolvedValue({ ...DOC, __updated: false });

    const result = await repo.updateWithVersion(
      'doc-1',
      { title: 'New' },
      { kind: 'versions', versions: [] },
    );

    expect(lastParams()).toEqual(['New', 'doc-1', []]);
    expect(result).toEqual({ outcome: 'conflict', currentVersion: 4 });
  });

  it('bumps the version and touches updated_at', async () => {
    mockQueryOne.mockResolvedValue({ ...DOC, __updated: true });

    await repo.updateWithVersion('doc-1', { title: 'New' }, ANY_VERSION);

    expect(lastSql()).toContain('"version" = "version" + 1');
    expect(lastSql()).toContain('"updated_at" = NOW()');
  });

  it('still issues an UPDATE when the patch has nothing writable in it', async () => {
    // `BaseRepository.update` short-circuits an empty patch to a read. Doing
    // that here would answer 200 to a request whose precondition was stale,
    // because the check lives in the statement that would have been skipped.
    mockQueryOne.mockResolvedValue({ ...DOC, __updated: false });

    const result = await repo.updateWithVersion(
      'doc-1',
      {},
      { kind: 'versions', versions: [1] },
    );

    expect(mockQueryOne).toHaveBeenCalledTimes(1);
    expect(lastSql()).toContain('UPDATE "docs" SET');
    expect(result.outcome).toBe('conflict');
  });

  it('produces a valid SET list with no patch and no timestamps', async () => {
    mockQueryOne.mockResolvedValue({ ...DOC, __updated: true });

    await noTsRepo.updateWithVersion('doc-1', {}, ANY_VERSION);

    // The version bump is what keeps `SET` from being empty here.
    expect(lastSql()).toContain('SET "version" = "version" + 1 WHERE');
    expect(lastSql()).not.toContain('updated_at');
  });

  it('refuses to write the version even when a caller puts it in the patch', async () => {
    mockQueryOne.mockResolvedValue({ ...DOC, __updated: true });

    await repo.updateWithVersion('doc-1', { title: 'New', version: 99 }, ANY_VERSION);

    // Forging the validator that guards your own write has to be impossible,
    // not merely discouraged.
    expect(lastParams()).toEqual(['New', 'doc-1']);
    expect(lastSql()).not.toContain('"version" = $');
  });

  it('resolves missing and conflicting in one statement, not two', async () => {
    mockQueryOne.mockResolvedValue({ ...DOC, __updated: true });

    await repo.updateWithVersion('doc-1', { title: 'New' }, ANY_VERSION);

    // A follow-up SELECT could be overtaken by a concurrent delete and would
    // report a genuine conflict as a 404.
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
    expect(lastSql()).toContain('NOT EXISTS (SELECT 1 FROM updated)');
  });
});

describe('VersionedRepository.updateWithVersion: the outcomes', () => {
  it('reports the updated row without the statement’s discriminator', async () => {
    mockQueryOne.mockResolvedValue({ ...DOC, version: 5, __updated: true });

    const result = await repo.updateWithVersion('doc-1', { title: 'New' }, ANY_VERSION);

    expect(result).toEqual({ outcome: 'updated', row: { ...DOC, version: 5 } });
    if (result.outcome !== 'updated') throw new Error('expected an update');
    expect(result.row).not.toHaveProperty('__updated');
  });

  it('keeps a Date a Date on the way back', async () => {
    // The discriminator is a column rather than `to_jsonb(row)` precisely so
    // that pg's own type parsing survives the round trip.
    mockQueryOne.mockResolvedValue({ ...DOC, __updated: true });

    const result = await repo.updateWithVersion('doc-1', { title: 'New' }, ANY_VERSION);
    if (result.outcome !== 'updated') throw new Error('expected an update');

    expect(result.row.created_at).toBeInstanceOf(Date);
  });

  it('reports a conflict with the version the write lost to', async () => {
    mockQueryOne.mockResolvedValue({ ...DOC, version: 9, __updated: false });

    const result = await repo.updateWithVersion(
      'doc-1',
      { title: 'New' },
      { kind: 'versions', versions: [4] },
    );

    expect(result).toEqual({ outcome: 'conflict', currentVersion: 9 });
  });

  it('reports missing when the statement returned no row at all', async () => {
    mockQueryOne.mockResolvedValue(null);

    const result = await repo.updateWithVersion('gone', { title: 'New' }, ANY_VERSION);

    expect(result).toEqual({ outcome: 'missing' });
  });
});

describe('VersionedRepository.deleteWithVersion', () => {
  it('constrains the delete to the versions the caller named', async () => {
    mockQueryOne.mockResolvedValue({ __deleted: true, version: null });

    await repo.deleteWithVersion('doc-1', { kind: 'versions', versions: [4] });

    expect(lastSql()).toContain('DELETE FROM "docs" WHERE "id" = $1 AND "version" = ANY($2::int[])');
    expect(lastParams()).toEqual(['doc-1', [4]]);
  });

  it('adds no version predicate for a wildcard precondition', async () => {
    mockQueryOne.mockResolvedValue({ __deleted: true, version: null });

    await repo.deleteWithVersion('doc-1', ANY_VERSION);

    expect(lastSql()).not.toContain('ANY(');
    expect(lastParams()).toEqual(['doc-1']);
  });

  it('reports the delete', async () => {
    mockQueryOne.mockResolvedValue({ __deleted: true, version: null });

    await expect(repo.deleteWithVersion('doc-1', ANY_VERSION)).resolves.toEqual({
      outcome: 'deleted',
    });
  });

  it('reports a conflict with the current version', async () => {
    mockQueryOne.mockResolvedValue({ __deleted: false, version: 9 });

    await expect(
      repo.deleteWithVersion('doc-1', { kind: 'versions', versions: [4] }),
    ).resolves.toEqual({ outcome: 'conflict', currentVersion: 9 });
  });

  it('reports missing when no row matched either branch', async () => {
    mockQueryOne.mockResolvedValue(null);

    await expect(repo.deleteWithVersion('gone', ANY_VERSION)).resolves.toEqual({
      outcome: 'missing',
    });
  });

  it('reports missing rather than trusting a null version off the wire', async () => {
    // Unreachable through the statement — the conflict branch reads a row whose
    // `version` is `NOT NULL` — but the value arrived from outside the process,
    // so it is checked instead of asserted.
    mockQueryOne.mockResolvedValue({ __deleted: false, version: null });

    await expect(repo.deleteWithVersion('doc-1', ANY_VERSION)).resolves.toEqual({
      outcome: 'missing',
    });
  });
});

describe('VersionedRepository and the inherited unconditional writes', () => {
  it('still refuses to write the version through plain update', async () => {
    mockQueryOne.mockResolvedValue(DOC);

    await repo.update('doc-1', { title: 'New', version: 99 });

    const [sql, params] = mockQueryOne.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toContain('"version"');
    expect(params).toEqual(['New', 'doc-1']);
  });
});
