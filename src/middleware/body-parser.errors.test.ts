import { bodyParserErrorTranslator } from '@/middleware/body-parser.errors';
import { AppError } from '@/lib/errors';

describe('bodyParserErrorTranslator', () => {
  it('maps an oversized body to 413 rather than leaving it a 500', () => {
    const err = Object.assign(new Error('request entity too large'), {
      type: 'entity.too.large',
      status: 413,
    });

    expect(bodyParserErrorTranslator(err)).toEqual({
      statusCode: 413,
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Request body exceeds the size limit',
    });
  });

  it('maps a parse failure to 400 without quoting what the caller sent', () => {
    // body-parser hands the input straight through in its message. Echoing it
    // puts a fragment of the request body in the response and the log, which is
    // the one place a credential pasted into the wrong field ends up next.
    const err = Object.assign(new SyntaxError('Unexpected token s in JSON at position 4 near sk_live_x'), {
      type: 'entity.parse.failed',
      status: 400,
    });

    const translated = bodyParserErrorTranslator(err);

    expect(translated).toMatchObject({ statusCode: 400, code: 'MALFORMED_BODY' });
    expect(translated?.message).not.toContain('sk_live_x');
  });

  it('declines an error carrying a status but none of body-parser’s tags', () => {
    // The reason it matches on `type` and not on `status`: half the ecosystem's
    // errors carry one, and claiming them here would turn genuine server faults
    // into tidy 4xx answers nobody investigates.
    expect(bodyParserErrorTranslator(new AppError(503, 'Dependency down'))).toBeNull();
    expect(bodyParserErrorTranslator(Object.assign(new Error('nope'), { status: 400 }))).toBeNull();
  });

  it('declines a tag it does not recognise, leaving the 500 fallback in place', () => {
    const err = Object.assign(new Error('stream is not readable'), {
      type: 'stream.not.readable',
      status: 500,
    });

    expect(bodyParserErrorTranslator(err)).toBeNull();
  });

  it('declines values that are not objects', () => {
    expect(bodyParserErrorTranslator(null)).toBeNull();
    expect(bodyParserErrorTranslator('entity.too.large')).toBeNull();
    expect(bodyParserErrorTranslator(undefined)).toBeNull();
  });
});
