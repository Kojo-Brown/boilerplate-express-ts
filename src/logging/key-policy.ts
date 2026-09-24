/**
 * Which property names are sensitive, and how a name is matched.
 *
 * The matching rule is the part worth reading. The two obvious ones are both
 * wrong in a way that shows up in production rather than in review:
 *
 *  - **Exact match** on the normalised name misses every real field, because
 *    nobody calls it `email`. They call it `userEmail`, `email_address`,
 *    `customerEmailAddress`, and the deny list quietly matches none of them.
 *  - **Substring match** over-matches, and the damage is worse than a missed
 *    secret because it is silent: `pass` eats `passengers` and `passed`, `card`
 *    eats `discardedAt`, and the operator is left reading a log where a third
 *    of the fields say `[redacted]` for no reason. That is how a team ends up
 *    disabling redaction entirely.
 *
 * So a key is split into words — on separators, on camelCase humps, and on the
 * letter/digit boundary — and it is sensitive when any *contiguous run* of
 * those words spells one of the terms below. `userEmail` → `user|email` → hits
 * on `email`; `passengers` → `passengers` → hits on nothing; `x-api-key` →
 * `x|api|key` → hits on `apikey` via the two-word run. That is the whole trick,
 * and it is why the terms are stored with their separators already removed.
 */

/** Longest run of words joined before giving up; `socialSecurityNumber` is 3. */
const MAX_RUN_WORDS = 4;

/**
 * The built-in terms, separators removed, lower case.
 *
 * Read the omissions as decisions, because each one cost something:
 *
 *  - **`name`** is not here. It is a word in `eventName`, `queueName`,
 *    `routeName` and `strategy.name`; redacting those would hollow out every
 *    structured line this service writes. The person's name is covered by the
 *    compounds — `firstName`, `fullName`, `surname`.
 *  - **`address`** is not here either, for the same reason in the other
 *    direction: it is a word in `ipAddress` and `remoteAddress`, and an IP is
 *    the field an on-call engineer actually needs. `streetAddress` and
 *    `postalCode` are listed instead. A deployment whose regulator treats an IP
 *    as personal data adds `ipAddress` through `extraKeys` — that is what the
 *    hook is for, and it is a deployment's call rather than a library's.
 *  - **`id`** is not here. A user id is a pseudonym, it is the join key for
 *    every other log line, and a redacted one makes the audit trail useless
 *    while protecting nothing an attacker could not already enumerate.
 *  - **`signature`** is not here: an HMAC over a payload is not a credential,
 *    and it is the field you need when a webhook is being rejected.
 */
export const DEFAULT_SENSITIVE_KEYS: readonly string[] = [
  // Credentials and secrets.
  'password',
  'passwd',
  'pwd',
  'passphrase',
  'secret',
  'token',
  'apikey',
  'authorization',
  'cookie',
  'sessionid',
  'privatekey',
  'credentials',
  'otp',
  // Direct identifiers.
  'email',
  'phone',
  'ssn',
  'socialsecuritynumber',
  'nationalid',
  'passportnumber',
  'dob',
  'dateofbirth',
  'birthdate',
  'firstname',
  'lastname',
  'fullname',
  'givenname',
  'familyname',
  'surname',
  'streetaddress',
  'postalcode',
  'postcode',
  'zipcode',
  // Payment instruments.
  'creditcard',
  'cardnumber',
  'cvv',
  'cvc',
  'iban',
];

/**
 * Every run of words in `key`, joined, lower case.
 *
 * Exported for the tests, which is the only way to pin the splitting rules
 * themselves rather than the handful of names that happen to exercise them.
 */
export function keyRuns(key: string): string[] {
  const words = key
    .split(/[^A-Za-z0-9]+/u)
    // camelCase (`userEmail`), the acronym-then-word boundary (`APIKey` →
    // `API|Key`, not `A|P|I|Key`), and letter-to-digit (`address2`).
    .flatMap((part) =>
      part.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[A-Za-z])(?=[0-9])/u),
    )
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());

  const runs: string[] = [];
  for (let start = 0; start < words.length; start += 1) {
    let run = '';
    for (let length = 0; length < MAX_RUN_WORDS && start + length < words.length; length += 1) {
      run += words[start + length];
      runs.push(run);
    }
  }
  return runs;
}

/**
 * How many distinct keys a matcher remembers before it forgets all of them.
 *
 * There is a cache at all because the same two dozen field names recur on every
 * line, and it is bounded because they are not the only keys that reach here: a
 * rejected request body echoed into an error is attacker-supplied, and an
 * unbounded memo on attacker-supplied strings is a memory leak with a remote
 * trigger. Clearing wholesale rather than evicting an LRU keeps this to one
 * branch on the hot path; the steady-state key set is tiny, so the clear either
 * never happens or is happening because the input is adversarial, and neither
 * case wants a heap of bookkeeping.
 */
const MAX_CACHED_KEYS = 4_096;

export type SensitiveKeyMatcher = (key: string) => boolean;

/**
 * Builds the matcher used for one redactor.
 *
 * `extraKeys` are normalised the same way the built-ins were, so a deployment
 * can write `X-API-Key` or `ip_address` in configuration and get the term the
 * runs are compared against.
 */
export function createSensitiveKeyMatcher(extraKeys: readonly string[] = []): SensitiveKeyMatcher {
  const terms = new Set<string>(DEFAULT_SENSITIVE_KEYS);
  for (const extra of extraKeys) {
    const normalised = extra.replace(/[^A-Za-z0-9]+/gu, '').toLowerCase();
    if (normalised.length > 0) terms.add(normalised);
  }

  const cache = new Map<string, boolean>();

  return function isSensitiveKey(key: string): boolean {
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    const sensitive = keyRuns(key).some((run) => terms.has(run));

    if (cache.size >= MAX_CACHED_KEYS) cache.clear();
    cache.set(key, sensitive);
    return sensitive;
  };
}
