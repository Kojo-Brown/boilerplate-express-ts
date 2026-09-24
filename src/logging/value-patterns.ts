import {
  REDACTED,
  REDACTED_CARD,
  REDACTED_EMAIL,
  REDACTED_IBAN,
  REDACTED_JWT,
} from '@/logging/redaction.types';

/**
 * Redaction by the *shape* of a value, for the fields whose name says nothing.
 *
 * The key policy handles `user.email`. It cannot handle the way secrets
 * actually reach a log, which is inside a string nobody labelled: a validation
 * error quoting the body it rejected, an upstream's 401 echoing the header it
 * refused, a `describeFailure` line carrying whatever the driver put in
 * `message`. Those all arrive as `{ error: "..." }`, and `error` is not a
 * sensitive key and must never become one.
 *
 * Every detector here is anchored to a *checkable* structure rather than a
 * plausible one. That is the difference between this and the regex pile these
 * usually turn into:
 *
 *  - a card number is 13–19 digits **that satisfy Luhn**, so the order id and
 *    the epoch-millis timestamp of the same length are left alone;
 *  - an IBAN is the country/checksum prefix **that satisfies mod-97**;
 *  - a JWT is three base64url segments whose first one begins `eyJ`, which is
 *    `{"` base64url-encoded and is therefore a property of the format rather
 *    than a guess.
 *
 * A detector without a check — "looks like a phone number", "looks like an
 * address" — is deliberately absent. Its false positives land on the numbers an
 * operator is reading the log *for*, and it teaches people that `[redacted]`
 * means "ignore this", which is the one thing a redaction marker must never
 * come to mean.
 *
 * The passes are ordered and the order matters: `Bearer eyJ…` should read
 * `Bearer [redacted]` rather than lose the scheme, and an IBAN written with
 * spaces contains a digit run a card detector would otherwise be offered. No
 * marker is matched by any later pattern — none of them contains `@`, a dot
 * between base64url segments, or thirteen digits — so the pass is idempotent.
 */

/** `Authorization`-style credentials, which keep their scheme and lose the rest. */
const AUTH_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu;

/** Three base64url segments, the first one starting with the encoded `{"`. */
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/gu;

/**
 * Country code, check digits, then the rest — compact, or in the spaced groups
 * a person types. The groups are where `redactIbanMatch` earns its keep.
 */
const IBAN = /\b[A-Z]{2}[0-9]{2}[A-Za-z0-9]{0,30}(?: [A-Za-z0-9]{1,4}){0,8}\b/gu;

/** 13–19 digits, optionally grouped by a space or a dash. */
const CARD = /\b(?:\d[ -]?){12,18}\d\b/gu;

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/gu;

/** The Luhn checksum every card scheme's numbering plan satisfies. */
export function passesLuhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;

  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48;
    if (digit < 0 || digit > 9) return false;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/** ISO 13616's mod-97 check: move the first four characters to the end, expect 1. */
export function passesIbanChecksum(iban: string): boolean {
  const compact = iban.replace(/\s+/gu, '').toUpperCase();
  if (compact.length < 15 || compact.length > 34) return false;
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/u.test(compact)) return false;

  const rearranged = compact.slice(4) + compact.slice(0, 4);

  // The number is far past `Number.MAX_SAFE_INTEGER`, so it is reduced as it is
  // read. A letter contributes two decimal digits (`A` is 10), which is why the
  // multiplier depends on the character rather than being a constant 10.
  let remainder = 0;
  for (const character of rearranged) {
    const code = character.charCodeAt(0);
    const value = code >= 65 ? code - 55 : code - 48;
    remainder = (remainder * (value > 9 ? 100 : 10) + value) % 97;
  }
  return remainder === 1;
}

/**
 * Decides how much of a candidate IBAN match is actually the IBAN.
 *
 * A spaced IBAN ends in a group of one to four characters, which is also what
 * the next word in the sentence looks like — `… 7654 32 ada@example.com` offers
 * the regex one more group than there is IBAN, and a plain checksum test on the
 * greedy match rejects the whole thing and prints the account number. So the
 * trailing groups are dropped one at a time until what is left checks out, and
 * the surplus is handed back to the remaining passes. That is at most nine
 * mod-97 runs on a match that is already rare, and it is the difference between
 * a detector that works in a log line and one that works on a value on its own.
 */
function redactIbanMatch(match: string): string {
  const parts = match.split(' ');
  for (let end = parts.length; end >= 1; end -= 1) {
    if (!passesIbanChecksum(parts.slice(0, end).join(' '))) continue;

    const surplus = parts.slice(end).join(' ');
    return surplus.length > 0 ? `${REDACTED_IBAN} ${surplus}` : REDACTED_IBAN;
  }
  return match;
}

/**
 * Runs every detector over one string.
 *
 * Callers pass strings that have already survived the key policy — a value
 * under a sensitive key never reaches here, because it was replaced whole.
 */
export function redactText(text: string): string {
  return text
    .replace(AUTH_SCHEME, (_match, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(JWT, REDACTED_JWT)
    .replace(IBAN, redactIbanMatch)
    .replace(CARD, (match) => (passesLuhn(match.replace(/[ -]/gu, '')) ? REDACTED_CARD : match))
    .replace(EMAIL, REDACTED_EMAIL);
}
