import { resolveHost } from './activity.js';
import { USAGE, UsageError, parseArgs } from './cli.js';
import { startDaemon } from './daemon.js';
import { BannedGitCommandError, Git, formatArgs } from './git.js';
import { createLogger } from './log.js';
import { PreflightError, Syncer, preflight } from './sync.js';

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_PAUSED = 3;

const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'];

/** Runs the pairsync CLI; resolves with the process exit code. */
export async function main(argv, { cwd = process.cwd(), env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    stderr.write(`pairsync: ${error.message}\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  if (options.help) {
    stdout.write(USAGE);
    return EXIT_OK;
  }

  const log = createLogger({ stream: stdout, quiet: options.quiet, color: Boolean(stdout.isTTY) && !env.NO_COLOR });
  const git = new Git({
    cwd,
    env,
    dryRun: options.dryRun,
    onDryRun: (args) => log.info(`[dry-run] git ${formatArgs(args)}`),
  });

  let repo;
  try {
    repo = await preflight({ git, branch: options.branch });
  } catch (error) {
    if (!(error instanceof PreflightError)) throw error;
    stderr.write(`pairsync: ${error.message}\n`);
    return EXIT_ERROR;
  }

  const host = resolveHost(env);
  const syncer = new Syncer({ git, ...repo, host, log, debounceMs: options.debounceMs, push: options.push });

  if (options.once) {
    try {
      const result = await syncer.cycle();
      if (result.status === 'paused') return EXIT_PAUSED;
      return result.status === 'error' ? EXIT_ERROR : EXIT_OK;
    } catch (error) {
      if (!(error instanceof BannedGitCommandError)) throw error;
      stderr.write(`pairsync: ${error.message}\n`);
      return EXIT_ERROR;
    }
  }

  const modes = [options.dryRun && 'dry-run', !options.push && 'no-push'].filter(Boolean);
  log.info(
    `watching ${repo.root} as ${host}: syncing ${repo.branch} with origin/${repo.branch} ` +
      `(debounce ${options.debounceMs}ms, poll every ${options.intervalMs / 1000}s${modes.map((m) => `, ${m}`).join('')})`,
  );
  const daemon = startDaemon({
    syncer,
    root: repo.root,
    debounceMs: options.debounceMs,
    intervalMs: options.intervalMs,
    log,
  });

  let signalled = false;
  const onSignal = () => {
    if (signalled) process.exit(130);
    signalled = true;
    log.info('stopping after the current cycle (press Ctrl+C again to quit immediately)');
    daemon.stop();
  };
  for (const signal of STOP_SIGNALS) process.on(signal, onSignal);
  const failure = await daemon.done;
  for (const signal of STOP_SIGNALS) process.off(signal, onSignal);
  log.info('stopped');
  return failure === null ? EXIT_OK : EXIT_ERROR;
}
