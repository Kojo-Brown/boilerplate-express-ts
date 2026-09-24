import { createSensitiveKeyMatcher } from '@/logging/key-policy';
import type { SensitiveKeyMatcher } from '@/logging/key-policy';
import { redactText } from '@/logging/value-patterns';
import {
  CIRCULAR,
  DEFAULT_REDACTION_POLICY,
  OPAQUE,
  REDACTED,
  TRUNCATED_DEPTH,
  UNSERIALISABLE,
} from '@/logging/redaction.types';
import type { RedactionPolicy, Redactor } from '@/logging/redaction.types';

/**
 * The structural half: walk a value, hand every string to the detectors, and
 * replace anything sitting under a sensitive key without looking at it.
 *
 * "Without looking at it" is the important half of that sentence. A sensitive
 * key replaces its whole subtree rather than descending into it, because the
 * detectors only recognise the shapes they were taught and `credentials` may
 * hold anything at all. The key is the stronger signal, so it wins outright.
 * The marker it leaves is the untyped `[redacted]` rather than one of the
 * specific ones, and nothing is lost by that: the key survives beside it, so
 * `"email": "[redacted]"` already says what was removed.
 *
 * The walk is deliberately conservative about *what* it will descend into.
 * Arrays, plain objects, `Error`s and `Date`s are rendered; everything else is
 * summarised by type and size. That rules out the failure this module exists to
 * prevent, which is not really `logger.info({ password })` — somebody catches
 * that in review — it is `logger.error({ err, req })`, where `req` is an
 * Express request holding headers, a session, a socket and a reference to the
 * whole application. Walking arbitrary class instances is how one careless log
 * line prints an entire configuration, and no deny list of key names will save
 * it.
 */

/** The marker left in place of array elements past the cap. */
export function truncatedItems(count: number): string {
  return `[truncated:${count} more item${count === 1 ? '' : 's'}]`;
}

/** What an unwalked value is reduced to: its type and, where it has one, its size. */
function describeOpaque(value: object): string {
  if (typeof value === 'function') return '[opaque:function]';
  if (value instanceof Map) return `[opaque:Map(${value.size})]`;
  if (value instanceof Set) return `[opaque:Set(${value.size})]`;
  if (ArrayBuffer.isView(value)) return `[opaque:${value.constructor.name}(${value.byteLength})]`;
  if (value instanceof ArrayBuffer) return `[opaque:ArrayBuffer(${value.byteLength})]`;

  const name = value.constructor?.name;
  return typeof name === 'string' && name.length > 0 ? `[opaque:${name}]` : OPAQUE;
}

/**
 * True for the object literals a log record is actually made of.
 *
 * `Object.create(null)` counts: it is the shape a careful parser produces to
 * avoid prototype pollution, and it is a plain bag of data by any reading.
 */
function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

interface Walker {
  readonly policy: RedactionPolicy;
  readonly isSensitiveKey: SensitiveKeyMatcher;
}

function visitString(walker: Walker, value: string): string {
  // Detectors first, truncation second. The other order is cheaper and wrong:
  // cutting at 2,000 characters can leave the local part of an address or the
  // first half of a token in the line, which is a leak that looks like a
  // redaction. Every pattern uses bounded repetition, so scanning the whole
  // string is linear in its length rather than a backtracking hazard.
  const redacted = redactText(value);
  return redacted.length > walker.policy.maxStringLength
    ? `${redacted.slice(0, walker.policy.maxStringLength)}…`
    : redacted;
}

function visitError(walker: Walker, error: Error, depth: number, ancestors: object[]): unknown {
  const rendered: Record<string, unknown> = {
    name: error.name,
    message: visitString(walker, error.message),
  };

  if (typeof error.stack === 'string') rendered.stack = visitString(walker, error.stack);
  if (error.cause !== undefined) rendered.cause = visit(walker, error.cause, depth + 1, ancestors);

  // Own enumerable properties, so a typed error's `code` and `statusCode`
  // survive — they are most of why the codebase throws typed errors at all.
  // `name`, `message` and `stack` are above; `cause` is above and is not
  // enumerable on a natively constructed error anyway.
  for (const [key, value] of Object.entries(error)) {
    if (key === 'name' || key === 'message' || key === 'stack' || key === 'cause') continue;
    rendered[visitString(walker, key)] = walker.isSensitiveKey(key)
      ? REDACTED
      : visit(walker, value, depth + 1, ancestors);
  }

  return rendered;
}

function visit(walker: Walker, value: unknown, depth: number, ancestors: object[]): unknown {
  switch (typeof value) {
    case 'string':
      return visitString(walker, value);
    case 'number':
      // `NaN` and the infinities serialise as `null`, which reads in a log as
      // "the field was absent" and sends the reader looking for the wrong bug.
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
    case 'undefined':
      return value;
    case 'bigint':
      // `JSON.stringify` throws on a bigint rather than skipping it, so leaving
      // it alone would take the log line — and the call site — down.
      return `${value.toString()}n`;
    case 'symbol':
      return value.toString();
    case 'function':
      return describeOpaque(value);
    default:
      break;
  }

  if (value === null) return null;

  const object = value as object;

  // Ancestors, not a global set of everything seen. A record that mentions the
  // same tenant object under two keys is a tree with a shared leaf, and marking
  // the second mention `[circular]` would be a lie that hides a field. Only a
  // node that is its own ancestor would actually not terminate. The scan is
  // linear in the current depth, which `maxDepth` bounds to single digits.
  if (ancestors.includes(object)) return CIRCULAR;
  if (depth > walker.policy.maxDepth) return TRUNCATED_DEPTH;

  if (object instanceof Date) {
    // An invalid date throws from `toISOString`, and a logger must not.
    return Number.isNaN(object.getTime()) ? 'Invalid Date' : object.toISOString();
  }

  if (object instanceof Error) {
    ancestors.push(object);
    try {
      return visitError(walker, object, depth, ancestors);
    } finally {
      ancestors.pop();
    }
  }

  if (Array.isArray(object)) {
    ancestors.push(object);
    try {
      const kept = object
        .slice(0, walker.policy.maxArrayLength)
        .map((element) => visit(walker, element, depth + 1, ancestors));

      const dropped = object.length - kept.length;
      if (dropped > 0) kept.push(truncatedItems(dropped));
      return kept;
    } finally {
      ancestors.pop();
    }
  }

  if (!isPlainObject(object)) return describeOpaque(object);

  ancestors.push(object);
  try {
    const rendered: Record<string, unknown> = {};
    for (const [key, property] of Object.entries(object)) {
      // The key is redacted too. A record keyed by address —
      // `{ "ada@example.com": { … } }` — leaks exactly as much as one with the
      // address in a value, and two keys that redact to the same marker
      // collapse into one entry, which is the right trade in a log line.
      rendered[visitString(walker, key)] = walker.isSensitiveKey(key)
        ? REDACTED
        : visit(walker, property, depth + 1, ancestors);
    }
    return rendered;
  } finally {
    ancestors.pop();
  }
}

/**
 * Builds a redactor. One per policy, reused for every line: the key matcher it
 * closes over memoises, and that memo is the only state involved.
 */
export function createRedactor(policy: Partial<RedactionPolicy> = {}): Redactor {
  const resolved: RedactionPolicy = { ...DEFAULT_REDACTION_POLICY, ...policy };
  const walker: Walker = {
    policy: resolved,
    isSensitiveKey: createSensitiveKeyMatcher(resolved.extraKeys),
  };

  return function redact(value: unknown): unknown {
    // One catch for the whole walk rather than one per node. Nothing above is
    // expected to throw — but `Object.entries` runs getters, and a getter on
    // something a caller logged is code this module has never seen. Failing
    // closed, to a value that contains none of the input, is the only answer
    // that is still correct when the thing that threw was holding a secret.
    try {
      return visit(walker, value, 0, []);
    } catch {
      return UNSERIALISABLE;
    }
  };
}

/** The shared redactor, for sinks with no reason to configure their own. */
export const redactForLog: Redactor = createRedactor();
