import { EventEmitter } from 'node:events';
import fs from 'node:fs';

import { BannedGitCommandError } from './git.js';
import { maxDeferMs as computeMaxDeferMs } from './sync.js';

const GIT_INTERNAL = /(^|[\\/])\.git([\\/]|$)/;

/**
 * Runs sync cycles until stopped: once at startup, after `debounceMs` of quiet following a
 * file change (bursts coalesce into one cycle, but are never deferred past maxDeferMs), and
 * on every `intervalMs` poll tick as a backstop for missed fs events.
 * Cycles never overlap; requests that arrive mid-cycle run once afterwards.
 * Emits `cycle` with each result. `done` resolves with null, or with the error that stopped it.
 */
export function startDaemon({ syncer, root, debounceMs, intervalMs, log }) {
  const events = new EventEmitter();
  const maxDeferMs = computeMaxDeferMs(debounceMs);
  let stopping = false;
  let running = null;
  let pending = null;
  let debounceTimer = null;
  let burstStartedAt = 0;
  let watcher = null;
  let pollTimer = null;
  let failure = null;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  const stop = () => {
    if (!stopping) {
      stopping = true;
      clearTimeout(debounceTimer);
      clearInterval(pollTimer);
      watcher?.close();
      // Let the in-flight cycle finish: killing git mid-operation could leave a lock behind.
      Promise.resolve(running).then(() => resolveDone(failure));
    }
    return done;
  };

  const loop = async (first) => {
    for (let trigger = first; trigger !== null && !stopping; trigger = pending) {
      pending = null;
      try {
        events.emit('cycle', await syncer.cycle({ trigger }));
      } catch (error) {
        failure = error;
        log.error(
          error instanceof BannedGitCommandError
            ? `stopping: ${error.message}`
            : `stopping after an unexpected error: ${error.stack ?? error.message}`,
        );
        stop();
        return;
      }
    }
  };

  const request = (trigger) => {
    if (stopping) return;
    if (running !== null) {
      if (pending !== 'poll') pending = trigger;
      return;
    }
    running = loop(trigger).finally(() => {
      running = null;
    });
  };

  const onFileEvent = (_eventType, filename) => {
    if (filename && GIT_INTERNAL.test(filename)) return;
    const now = Date.now();
    if (debounceTimer === null) burstStartedAt = now;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(
      () => {
        debounceTimer = null;
        request('change');
      },
      Math.max(0, Math.min(debounceMs, burstStartedAt + maxDeferMs - now)),
    );
  };

  const fallback = (error) =>
    log.warn(`file watching is unavailable (${error.message}); relying on the ${intervalMs / 1000}s poll instead`);
  try {
    watcher = fs.watch(root, { recursive: true }, onFileEvent);
    watcher.on('error', (error) => {
      watcher.close();
      watcher = null;
      fallback(error);
    });
  } catch (error) {
    fallback(error);
  }

  pollTimer = setInterval(() => request('poll'), intervalMs);
  request('poll');

  return { events, done, stop };
}
