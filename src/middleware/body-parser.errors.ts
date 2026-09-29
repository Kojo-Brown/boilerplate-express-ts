import type { ErrorTranslator, TranslatedError } from '@/lib/error-translators';

/**
 * What `express.json()`, `express.urlencoded()` and `express.raw()` throw when
 * they refuse a request, mapped onto the envelope the rest of the API answers
 * in.
 *
 * Every one of these is the *client's* doing, and untranslated every one of
 * them was a 500. The body-size limit is the case that matters and the one that
 * reads worst: `express.json()` caps a body at 100 kB, the cap works, the
 * request is refused — and the caller is told "An unexpected error occurred",
 * which is both a lie and unactionable, while this process writes a stack trace
 * to the error log for a request it correctly rejected. Anyone can then fill
 * that log from an unauthenticated endpoint by sending large bodies, which
 * turns a resource-consumption control into a resource-consumption problem of
 * its own.
 *
 * The messages here are fixed strings and deliberately not `err.message`.
 * body-parser's parse failures quote the input — "Unexpected token '<' at
 * position 0" — so passing the message through echoes a fragment of whatever
 * the caller sent back to them and into the logs, and what a caller sent is
 * exactly the kind of thing that turns out to have had a credential in it.
 * The status and the code say what is wrong; the byte that upset the parser is
 * the caller's to find.
 *
 * Matching is on body-parser's own `type` tag rather than on a numeric
 * `status`, because `status` is a property half the ecosystem's errors carry
 * and claiming all of them here would quietly translate genuine server faults
 * into tidy 4xx answers. An unrecognised `entity.*`/`request.*` tag is left
 * alone for the same reason — the fallback is a 500, which is the right answer
 * for something nobody here has thought about.
 */
const BODY_PARSER_RESPONSES: Record<string, TranslatedError> = {
  'entity.too.large': {
    statusCode: 413,
    code: 'PAYLOAD_TOO_LARGE',
    message: 'Request body exceeds the size limit',
  },
  'entity.parse.failed': {
    statusCode: 400,
    code: 'MALFORMED_BODY',
    message: 'Request body could not be parsed',
  },
  'entity.verify.failed': {
    statusCode: 403,
    code: 'BODY_VERIFICATION_FAILED',
    message: 'Request body failed verification',
  },
  'request.aborted': {
    statusCode: 400,
    code: 'REQUEST_ABORTED',
    message: 'Request was aborted before the body arrived',
  },
  'request.size.invalid': {
    statusCode: 400,
    code: 'CONTENT_LENGTH_MISMATCH',
    message: 'Request body length did not match Content-Length',
  },
  'parameters.too.many': {
    statusCode: 413,
    code: 'TOO_MANY_PARAMETERS',
    message: 'Request body has too many parameters',
  },
  'charset.unsupported': {
    statusCode: 415,
    code: 'UNSUPPORTED_CHARSET',
    message: 'Request body charset is not supported',
  },
  'encoding.unsupported': {
    statusCode: 415,
    code: 'UNSUPPORTED_ENCODING',
    message: 'Request body content encoding is not supported',
  },
};

export const bodyParserErrorTranslator: ErrorTranslator = (err) => {
  if (typeof err !== 'object' || err === null) return null;

  const { type } = err as { type?: unknown };
  if (typeof type !== 'string') return null;

  return BODY_PARSER_RESPONSES[type] ?? null;
};
