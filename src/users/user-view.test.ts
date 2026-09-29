import { toPublicUser, toPublicUsers } from '@/users/user-view';
import type { UserRow } from '@/users/users.repository';

const ROW: UserRow = {
  id: 'user-uuid-1',
  email: 'alice@example.com',
  password_hash: '$argon2id$v=19$m=65536,t=3,p=4$obviously-fake$AAAAAAAAAAAAAAAAAAAAAA',
  roles: ['admin', 'user'],
  created_at: new Date('2024-01-01T00:00:00Z'),
  updated_at: new Date('2024-01-02T00:00:00Z'),
  version: 3,
};

describe('toPublicUser', () => {
  it('drops the password digest', () => {
    expect(toPublicUser(ROW)).not.toHaveProperty('password_hash');
  });

  it('keeps everything a client needs, version included', () => {
    expect(toPublicUser(ROW)).toEqual({
      id: 'user-uuid-1',
      email: 'alice@example.com',
      roles: ['admin', 'user'],
      created_at: new Date('2024-01-01T00:00:00Z'),
      updated_at: new Date('2024-01-02T00:00:00Z'),
      version: 3,
    });
  });

  /**
   * The case the allow-list shape exists for, and the one a `delete
   * row.password_hash` implementation fails: a column nobody here has heard of
   * must not reach a client merely because a migration added it.
   */
  it('omits a column the table grew that nothing here named', () => {
    const withNewColumn = { ...ROW, totp_secret: 'JBSWY3DPEHPK3PXP' } as unknown as UserRow;

    expect(toPublicUser(withNewColumn)).not.toHaveProperty('totp_secret');
  });

  it('projects every row of a collection', () => {
    const rows = [ROW, { ...ROW, id: 'user-uuid-2', email: 'bob@example.com' }];

    expect(toPublicUsers(rows).map((u) => u.id)).toEqual(['user-uuid-1', 'user-uuid-2']);
    for (const user of toPublicUsers(rows)) {
      expect(user).not.toHaveProperty('password_hash');
    }
  });
});
