import { createLifecycle } from '@/shutdown/lifecycle';
import type { Lifecycle } from '@/shutdown/lifecycle';

/**
 * The process's own lifecycle, as a singleton.
 *
 * A singleton for the reason `domainEventStreamHub` is one: there is exactly one
 * process and this describes it, so two of them would be two answers to the same
 * question — a health route reporting ready while the shutdown sequence it does
 * not share is halfway through closing the listener.
 *
 * Kept apart from `createLifecycle` for the same reason that hub keeps its
 * factory in another file: every test in this directory drives a lifecycle of
 * its own, and a module that could only be exercised through the process-wide
 * instance would leak state from one test into the next.
 */
export const appLifecycle: Lifecycle = createLifecycle();
