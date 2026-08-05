import { AppError, ValidationError } from '@/lib/errors';

/**
 * The wire-level shape an error is reduced to before it reaches `sendFail`.
 * Deliberately free of any Express type so translators stay testable as pure
 * functions.
 */
export interface TranslatedError {
  statusCode: number;
  code: string;
  message: string;
  issues?: unknown[];
}

/**
 * Maps one *family* of errors onto a response. Returns `null` when the error is
 * none of its business, which is what lets the registry try the next candidate.
 */
export type ErrorTranslator = (err: unknown) => TranslatedError | null;

/**
 * Errors this module owns outright. Registered ahead of anything a feature
 * module contributes so an explicit `AppError` always wins over a heuristic
 * match on some library's error shape.
 *
 * `ValidationError` precedes `AppError` because it is a subclass — the reverse
 * order would swallow it and drop the `issues` array.
 */
const CORE_TRANSLATORS: readonly ErrorTranslator[] = [
  (err) =>
    err instanceof ValidationError
      ? { statusCode: 422, code: 'VALIDATION_ERROR', message: err.message, issues: err.issues }
      : null,
  (err) =>
    err instanceof AppError
      ? { statusCode: err.statusCode, code: err.code ?? 'INTERNAL_ERROR', message: err.message }
      : null,
];

const translators: ErrorTranslator[] = [...CORE_TRANSLATORS];

/**
 * Teaches the error middleware about a new error family without editing it.
 *
 * Idempotent by function identity: `createApp()` runs once per test file (and
 * more than once in some suites), and re-registering the same translator must
 * not grow the chain without bound.
 */
export function registerErrorTranslator(translator: ErrorTranslator): void {
  if (!translators.includes(translator)) {
    translators.push(translator);
  }
}

/**
 * First translator to claim the error wins. `null` means nothing recognised it,
 * and the caller is responsible for the 500 fallback — translators never
 * fabricate one, or a bad match would mask a genuine bug as a tidy 4xx.
 */
export function translateError(err: unknown): TranslatedError | null {
  for (const translator of translators) {
    const translated = translator(err);
    if (translated !== null) return translated;
  }
  return null;
}
