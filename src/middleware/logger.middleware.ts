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

morgan.token('correlation-id', (req: Request) => {
  const id = req.headers['x-correlation-id'];
  return typeof id === 'string' ? id : '-';
});

export const requestLogger = morgan(
  ':method :url :status :res[content-length] - :response-time ms [:correlation-id]',
);
