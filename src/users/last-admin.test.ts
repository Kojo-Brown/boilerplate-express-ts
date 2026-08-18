import { assertAdminRemains, patchRemovesAdminRole } from '@/users/last-admin';
import { LastAdminError } from '@/users/users.errors';
import type { UserRow } from '@/users/users.repository';

const admin = (id: string, roles: string[] = ['admin']): UserRow => ({
  id,
  email: `${id}@example.com`,
  password_hash: 'argon2id-mock:not-a-real-hash',
  roles,
  created_at: new Date('2024-01-01T00:00:00Z'),
  updated_at: new Date('2024-01-01T00:00:00Z'),
  version: 1,
});

describe('patchRemovesAdminRole', () => {
  it('is false when the patch does not mention roles', () => {
    expect(patchRemovesAdminRole({})).toBe(false);
    expect(patchRemovesAdminRole({ email: 'new@example.com' })).toBe(false);
  });

  it('is false when the new role list still contains admin', () => {
    expect(patchRemovesAdminRole({ roles: ['admin'] })).toBe(false);
    expect(patchRemovesAdminRole({ roles: ['user', 'admin'] })).toBe(false);
  });

  it('is true when the new role list drops admin', () => {
    expect(patchRemovesAdminRole({ roles: ['user'] })).toBe(true);
    expect(patchRemovesAdminRole({ roles: [] })).toBe(true);
  });

  /**
   * The patch replaces the list wholesale, so an empty one is a demotion for an
   * administrator and a no-op for everybody else. It cannot be waved through on
   * the grounds that it "removes nothing".
   */
  it('treats an empty role list as removing admin', () => {
    expect(patchRemovesAdminRole({ roles: [] })).toBe(true);
  });
});

describe('assertAdminRemains', () => {
  it('allows the write when another administrator survives it', () => {
    expect(() => assertAdminRemains([admin('a'), admin('b')], 'a')).not.toThrow();
  });

  it('refuses the write when the target is the only administrator', () => {
    expect(() => assertAdminRemains([admin('a')], 'a')).toThrow(LastAdminError);
  });

  it('answers 409 with a code a client can branch on', () => {
    try {
      assertAdminRemains([admin('a')], 'a');
      throw new Error('expected LastAdminError');
    } catch (err) {
      expect(err).toBeInstanceOf(LastAdminError);
      expect(err).toMatchObject({ statusCode: 409, code: 'LAST_ADMIN' });
    }
  });

  /**
   * The common case, and the one that must not throw: most users are not
   * administrators, and a write to one of them cannot shrink the set.
   */
  it('allows the write when the target is not in the locked set', () => {
    expect(() => assertAdminRemains([admin('a')], 'someone-else')).not.toThrow();
    expect(() => assertAdminRemains([], 'someone-else')).not.toThrow();
  });

  /**
   * An empty set means the invariant was already violated — by a migration, a
   * `psql` session, a seed that never ran. This does not throw, because
   * refusing every write in that state locks out the very edit that would fix
   * it: the target is not an administrator, so promoting somebody has to remain
   * possible.
   */
  it('does not refuse writes when there are already no administrators', () => {
    expect(() => assertAdminRemains([], 'a')).not.toThrow();
  });
});
