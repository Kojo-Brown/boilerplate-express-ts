import argon2 from 'argon2';

const OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, OPTIONS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    // Verification reads the variant and cost parameters from the encoded
    // digest itself, so `verify` only accepts a pepper (`secret`) — passing
    // `type` here is not just redundant, it is rejected by argon2's types.
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}
