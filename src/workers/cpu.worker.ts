// Thread entry point. Started by `WorkerPool` via an absolute path computed in
// `worker-entry.ts`; never imported by the main thread's module graph.
//
// Both imports are relative, and must stay that way — see the note at the top
// of `worker-runtime.ts`. Nothing in this file's graph may use the `@/` alias.
import { cpuTaskHandlers } from './cpu.tasks';
import { serveTasksOnParentPort } from './worker-runtime';

// Everything the thread does. There is no other top-level statement on purpose:
// a worker entry is re-executed in full for every thread the pool spawns and
// again for every one it replaces after a crash or a task timeout, so anything
// expensive, stateful or one-time-only here is paid per thread rather than per
// process — and a connection pool opened at this scope would be opened N times
// and closed none.
serveTasksOnParentPort(cpuTaskHandlers);
