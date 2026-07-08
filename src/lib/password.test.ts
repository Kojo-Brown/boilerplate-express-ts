import { hashPassword, verifyPassword } from '@/lib/password';

describe('hashPassword', () => {
  it('returns an argon2id hash string', async () => {
    const hash = await hashPassword('s3cr3t');
    expect(hash).toMatch(/^\$argon2id\$/);
  });

  it('produces different hashes for the same input (random salt)', async () => {
    const h1 = await hashPassword('s3cr3t');
    const h2 = await hashPassword('s3cr3t');
    expect(h1).not.toBe(h2);
  });
});

describe('verifyPassword', () => {
  it('returns true for a matching password', async () => {
    const hash = await hashPassword('correct-horse');
    expect(await verifyPassword('correct-horse', hash)).toBe(true);
  });

  it('returns false for a wrong password', async () => {
    const hash = await hashPassword('correct-horse');
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });

  it('returns false for a malformed hash without throwing', async () => {
    expect(await verifyPassword('anything', 'not-a-valid-hash')).toBe(false);
  });
});
