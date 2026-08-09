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

export const requestLogger = morgan(
  ':method :url :status :res[content-length] - :response-time ms [:correlation-id]',
);
