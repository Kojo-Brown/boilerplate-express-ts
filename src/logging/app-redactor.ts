import { env } from '@/config/env';
import { createRedactor } from '@/logging/redact';
import type { Redactor } from '@/logging/redaction.types';

/**
 * The process's redactor, built from configuration on first use.
 *
 * Lazy and memoised for the same reason `getFieldCipher` is: a module that
 * builds it at import builds it in every test file that transitively imports
 * anything that logs. `env` is validated at boot and frozen, so there is
 * nothing here that can fail later than it could have failed there.
 *
 * Splitting the list here rather than in the schema keeps `env.ts` a list of
 * validated *strings* — which is what makes the frozen `env` object's deep
 * freeze free, per the note at the bottom of that file.
 */
let redactor: Redactor | undefined;

export function parseExtraKeys(value: string): string[] {
  return value
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
}

export function getAppRedactor(): Redactor {
  redactor ??= createRedactor({ extraKeys: parseExtraKeys(env.LOG_REDACTION_EXTRA_KEYS) });
  return redactor;
}

/** Drop the memoised redactor. For tests that drive configuration, and nothing else. */
export function resetAppRedactor(): void {
  redactor = undefined;
}
