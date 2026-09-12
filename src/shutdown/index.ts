export type { Lifecycle, LifecycleState } from '@/shutdown/lifecycle';
export { createLifecycle } from '@/shutdown/lifecycle';

export { appLifecycle } from '@/shutdown/app-lifecycle';

export { ServerShuttingDownError } from '@/shutdown/shutdown.errors';

export type { ShutdownGuardOptions } from '@/shutdown/shutdown.middleware';
export { shutdownGuard } from '@/shutdown/shutdown.middleware';

export type { HttpDrain, HttpDrainOptions, HttpDrainReport } from '@/shutdown/http-drain';
export { trackHttpServer } from '@/shutdown/http-drain';

export type {
  GracefulShutdown,
  GracefulShutdownOptions,
  ShutdownLogger,
  ShutdownPhase,
  ShutdownReport,
  ShutdownTask,
  ShutdownTaskOutcome,
  ShutdownTaskResult,
} from '@/shutdown/graceful-shutdown';
export { createGracefulShutdown, waitTask } from '@/shutdown/graceful-shutdown';
