import morgan from 'morgan';
import { v4 as uuidv4 } from 'uuid';
import type { Request, Response, NextFunction } from 'express';

export function correlationIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const existing = req.headers['x-correlation-id'];
  const correlationId = typeof existing === 'string' ? existing : uuidv4();
  req.headers['x-correlation-id'] = correlationId;
  res.setHeader('x-correlation-id', correlationId);
  next();
}

/**
 * The correlation id `correlationIdMiddleware` put on the request, if it ran.
 *
 * `undefined` rather than a fresh id when it is missing: minting one here would
 * produce a value that appears in an audit line and in no access log, which
 * reads like a lost request rather than an unlabelled one.
 */
export function correlationIdOf(req: Request): string | undefined {
  const id = req.headers['x-correlation-id'];
  return typeof id === 'string' ? id : undefined;
}

morgan.token('correlation-id', (req: Request) => correlationIdOf(req) ?? '-');

/**
 * The trace id, or `-` when there is no trace.
 *
 * `-` covers tracing being disabled and the path being one `UNTRACED_PATHS`
 * skips, and it does not distinguish them, because the reader of an access log
 * wants neither answer: what they want is to paste an id into a trace UI, and
 * there either is one or there is not.
 *
 * Read off the request rather than out of the active context — see the note on
 * `Request.traceId`, which is where the reason lives.
 */
morgan.token('trace-id', (req: Request) => req.traceId ?? '-');

/**
 * Both ids on every line, which is the whole point of carrying two.
 *
 * The correlation id is this service's and spans its retries; the trace id is
 * the distributed one and is shared with every service that handled the same
 * request. A line with only one of them can be joined to logs or to traces, and
 * a line with both is what lets somebody move between them without a second
 * query.
 */
export const requestLogger = morgan(
  ':method :url :status :res[content-length] - :response-time ms [:correlation-id] [:trace-id]',
);
