import type { Response } from 'express';

export interface ApiMeta {
  [key: string]: unknown;
}

export interface ApiError {
  code: string;
  message: string;
  issues?: unknown[];
}

export interface ApiResponse<T = unknown> {
  data: T | null;
  meta: ApiMeta | null;
  error: ApiError | null;
}

export function ok<T>(data: T, meta?: ApiMeta): ApiResponse<T> {
  return { data, meta: meta ?? null, error: null };
}

export function created<T>(data: T, meta?: ApiMeta): ApiResponse<T> {
  return { data, meta: meta ?? null, error: null };
}

export function fail(code: string, message: string, issues?: unknown[]): ApiResponse<null> {
  const error: ApiError = { code, message };
  if (issues !== undefined) error.issues = issues;
  return { data: null, meta: null, error };
}

export function sendOk<T>(res: Response, data: T, meta?: ApiMeta): void {
  res.status(200).json(ok(data, meta));
}

export function sendCreated<T>(res: Response, data: T, meta?: ApiMeta): void {
  res.status(201).json(created(data, meta));
}

export function sendNoContent(res: Response): void {
  res.status(204).end();
}

export function sendFail(
  res: Response,
  statusCode: number,
  code: string,
  message: string,
  issues?: unknown[],
): void {
  res.status(statusCode).json(fail(code, message, issues));
}
