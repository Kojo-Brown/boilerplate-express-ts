import { createHash, randomBytes } from 'node:crypto';
import { cpuTaskHandlers, DIGEST_ALGORITHMS, digest } from '@/workers/cpu.tasks';
import type { DigestAlgorithm } from '@/workers/cpu.tasks';

describe('digest', () => {
  it.each(DIGEST_ALGORITHMS)('matches crypto.createHash for %s', (algorithm) => {
    const bytes = randomBytes(4096);

    const result = digest({ algorithm, bytes });

    expect(result).toEqual({
      algorithm,
      hex: createHash(algorithm).update(bytes).digest('hex'),
      byteLength: 4096,
    });
  });

  it('hashes an empty payload rather than treating it as absent', () => {
    const result = digest({ algorithm: 'sha256', bytes: new Uint8Array(0) });

    // The well-known SHA-256 of the empty string. Pinned as a literal because a
    // zero-length input is exactly where an off-by-one in a future streaming
    // rewrite would show up, and comparing against `createHash` of the same
    // empty buffer would agree with itself either way.
    expect(result.hex).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(result.byteLength).toBe(0);
  });

  /**
   * A `Buffer` is a `Uint8Array` subclass on this side of a thread boundary but
   * arrives as a plain `Uint8Array` on the other — structured clone does not
   * know the subclass. Both must hash identically, or the checksum would depend
   * on whether the work happened to be offloaded.
   */
  it('agrees between a Buffer and the plain Uint8Array it clones to', () => {
    const buffer = randomBytes(1024);
    const plain = new Uint8Array(buffer);

    expect(digest({ algorithm: 'sha256', bytes: plain }).hex).toBe(
      digest({ algorithm: 'sha256', bytes: buffer }).hex,
    );
  });

  it('hashes only the view, not the whole backing store', () => {
    const backing = randomBytes(64);
    const view = backing.subarray(16, 32);

    expect(digest({ algorithm: 'sha256', bytes: view }).hex).toBe(
      createHash('sha256').update(backing.subarray(16, 32)).digest('hex'),
    );
    expect(digest({ algorithm: 'sha256', bytes: view }).byteLength).toBe(16);
  });

  it('rejects an algorithm outside the union at runtime as well as at compile time', () => {
    // The cast is the point of the test: the type system stops this at every
    // call site inside the repo, and this asserts what happens when a value
    // arrives from somewhere the compiler could not see — a payload off the
    // wire, a JavaScript consumer.
    const algorithm = 'md5' as DigestAlgorithm;

    expect(() => digest({ algorithm, bytes: new Uint8Array(1) })).toThrow(TypeError);
    expect(() => digest({ algorithm, bytes: new Uint8Array(1) })).toThrow(/unsupported algorithm/);
  });
});

describe('cpuTaskHandlers', () => {
  it('registers every task the pool can be asked for', () => {
    expect(Object.keys(cpuTaskHandlers)).toEqual(['digest']);
    expect(cpuTaskHandlers.digest).toBe(digest);
  });
});
