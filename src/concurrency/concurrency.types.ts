/**
 * What an `If-Match` header asked for, reduced to something a write can act on.
 *
 * Two cases rather than a list of strings, because the two mean different
 * things to the SQL underneath: `any` is "I only require that it still exists"
 * and adds no predicate, while `versions` is a set the current row has to be a
 * member of. Collapsing them would mean encoding "match everything" as a
 * sentinel inside the version list, which is the kind of value a `WHERE` clause
 * eventually forgets to special-case.
 */
export type Precondition =
  | { readonly kind: 'any' }
  | { readonly kind: 'versions'; readonly versions: readonly number[] };

/** `If-Match: *` — the resource must exist; its version is not constrained. */
export const ANY_VERSION: Precondition = { kind: 'any' };

/**
 * The outcome of a write guarded by a `Precondition`.
 *
 * Three cases, because the caller owes the client three different answers and
 * a boolean cannot carry them. A conditional `UPDATE` that affects no rows is
 * ambiguous on its own — the row may be gone (404) or may be at a version the
 * caller did not name (412) — and answering 412 for a deleted row tells the
 * client to re-read a resource that will never come back.
 *
 * `currentVersion` rides along on the conflict so the response can name the
 * validator the client should have sent, which is the difference between one
 * more round trip and two.
 */
export type ConditionalUpdate<TRow> =
  | { readonly outcome: 'updated'; readonly row: TRow }
  | { readonly outcome: 'conflict'; readonly currentVersion: number }
  | { readonly outcome: 'missing' };

export type ConditionalDelete =
  | { readonly outcome: 'deleted' }
  | { readonly outcome: 'conflict'; readonly currentVersion: number }
  | { readonly outcome: 'missing' };
