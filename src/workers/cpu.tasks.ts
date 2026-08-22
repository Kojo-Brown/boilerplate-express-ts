import { createHash } from 'node:crypto';
// Relative for the reason given at the top of `worker-runtime.ts`: this module
// is in the worker entry's graph and has to resolve without `@/`.
import type { TaskHandlers } from './protocol';

/**
 * The CPU-bound tasks this service runs off the event loop, and the only place
 * their payload and result shapes are written down.
 *
 * Imported by both sides — `cpu.worker.ts` to serve them, `worker-pool` callers
 * to type `pool.run()` — so a payload change is a compile error at every call
 * site rather than a runtime `undefined` inside a thread.
 */

export const DIGEST_ALGORITHMS = ['sha256', 'sha512'] as const;

export type DigestAlgorithm = (typeof DIGEST_ALGORITHMS)[number];

export interface DigestRequest {
  readonly algorithm: DigestAlgorithm;
  /**
   * The bytes to hash.
   *
   * Typed `Uint8Array` rather than `Buffer` because that is what *arrives*: the
   * structured clone algorithm reconstructs a `Buffer` as a plain `Uint8Array`
   * on the far side — `Buffer` is a subclass the receiving isolate's clone
   * reader does not know about — so a handler annotated `Buffer` would be
   * lying, and any `Buffer` method it reached for would be `undefined`.
   */
  readonly bytes: Uint8Array;
}

export interface DigestResult {
  readonly algorithm: DigestAlgorithm;
  readonly hex: string;
  readonly byteLength: number;
}

/**
 * A `type` rather than an `interface extends TaskMap`, and the difference is
 * load-bearing. Extending would inherit `TaskMap`'s string index signature,
 * which `TaskHandlers` then maps to `(payload: unknown) => unknown` — and a
 * handler taking `DigestRequest` is not assignable to that, so the registry
 * below would not compile. A type alias satisfies `TaskMap` structurally via
 * TypeScript's implicit index signature instead, keeping each task's payload
 * type exactly as narrow as it was declared.
 */
export type CpuTasks = {
  readonly digest: { readonly payload: DigestRequest; readonly result: DigestResult };
};

/**
 * A content digest over a whole buffer.
 *
 * This is the shape of CPU work that actually justifies a thread. `createHash`
 * is synchronous C++ that never yields: hashing runs at roughly 1–2 GB/s, so a
 * 64 MiB upload is some 40ms during which the event loop accepts no
 * connections, fires no timers and answers no other request. Under any
 * concurrency at all those stall periods do not interleave — they queue — and
 * p99 latency for every *unrelated* endpoint degrades in proportion to upload
 * traffic.
 *
 * Contrast the hashing already in this codebase — `pkce.ts`, `secret-hash.ts`,
 * `advisory-lock.ts`, the idempotency fingerprint — all of which hash inputs
 * measured in bytes. Moving those to a thread would be strictly slower: the
 * message round trip costs more than the work. `WorkerPool` is not an
 * improvement you apply everywhere, and the size threshold in
 * `upload.checksum.ts` is where that judgement is written down.
 *
 * The algorithm is constrained to a union rather than taken as a string, so a
 * caller cannot reach an arbitrary OpenSSL algorithm name through a payload
 * that crossed a trust boundary — and so an unavailable one fails at the type
 * level instead of throwing inside a thread.
 */
export function digest(payload: DigestRequest): DigestResult {
  const { algorithm, bytes } = payload;

  if (!DIGEST_ALGORITHMS.includes(algorithm)) {
    throw new TypeError(
      `digest: unsupported algorithm ${JSON.stringify(algorithm)}; expected one of ${DIGEST_ALGORITHMS.join(', ')}`,
    );
  }

  return {
    algorithm,
    hex: createHash(algorithm).update(bytes).digest('hex'),
    byteLength: bytes.byteLength,
  };
}

export const cpuTaskHandlers: TaskHandlers<CpuTasks> = { digest };
