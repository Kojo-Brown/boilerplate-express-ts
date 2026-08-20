import { z } from 'zod';
import { STORAGE_DRIVERS } from '@/upload/storage/storage.types';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  DATABASE_URL: z.string().min(1),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),
  SESSION_SECRET: z.string().min(32).default('default-session-secret-for-pkce-state-only!!'),
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  GOOGLE_CALLBACK_URL: z.string().default('http://localhost:4000/v1/auth/oauth/google/callback'),
  AWS_REGION: z.string().default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string().default(''),
  AWS_SECRET_ACCESS_KEY: z.string().default(''),
  S3_BUCKET: z.string().default(''),
  S3_PRESIGNED_EXPIRES_IN: z.coerce.number().int().positive().default(3600),
  // Selects the adapter out of `storageRegistry`. Validated against the same
  // const the registry is keyed by, so an unregistered driver is rejected at
  // boot with the valid values listed, rather than on the first upload.
  STORAGE_DRIVER: z.enum(STORAGE_DRIVERS).default('s3'),
  // How long an issued magic link stays redeemable. Short by default: the link
  // is a bearer credential sitting in an inbox, and 15 minutes is long enough
  // for mail delivery plus a distracted user without leaving one live in an
  // archive for a week.
  MAGIC_LINK_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  // How long a recorded response stays replayable. A day matches what client
  // libraries assume when they retry a failed submission, and is the window
  // during which a duplicate is absorbed rather than executed.
  IDEMPOTENCY_RETENTION_SECONDS: z.coerce.number().int().positive().default(86_400),
  // How long an unfinished claim blocks a retry before it is treated as
  // abandoned. Must stay above the slowest guarded route: below it, a merely
  // slow request is taken over and its work runs twice.
  IDEMPOTENCY_LEASE_SECONDS: z.coerce.number().int().positive().default(60),
  // How often each replica reaches for the purge lock. Only one wins per tick,
  // so this is a per-service sweep interval rather than a per-replica one, and
  // it does not need lowering as replicas are added. An hour is far below the
  // default 24h retention, which is what keeps the table's steady-state size
  // proportional to a day of traffic rather than to uptime. `0` disables the
  // in-process job — the deployment that wants an external cron instead.
  IDEMPOTENCY_PURGE_INTERVAL_SECONDS: z.coerce.number().int().nonnegative().default(3600),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
