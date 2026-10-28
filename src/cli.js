import { parseArgs as parseNodeArgs } from 'node:util';

export const DEFAULT_INTERVAL_MS = 10_000;
export const DEFAULT_DEBOUNCE_MS = 1500;
const MAX_TIMER_MS = 2_147_483_647;

export const USAGE = `Usage: pairsync [options]

Keeps the checked-out branch of this clone in sync with the same branch on origin, so
two people (or their coding agents) can edit one repository on two machines at once.
Local changes are committed first, the other side's commits are merged (never rebased),
and the result is pushed. pairsync never runs a git command that can destroy work.

Options:
  --branch <name>    branch to sync; must be the checked-out branch (default: current branch)
  --interval <sec>   backstop poll interval in seconds (default: 10)
  --debounce <ms>    quiet period after the last file change before committing (default: 1500)
  --once             run one full sync cycle, then exit
  --dry-run          print the git commands that would change something instead of running them
  --no-push          commit and merge locally, never push
  --quiet            print only warnings, conflicts and errors
  -h, --help         show this help

Environment:
  PAIRSYNC_HOST      name for this machine in commit messages and in .pairsync-shared/<name>.json
                     (default: the hostname); set it if both machines have the same hostname

Exit codes: 0 ok, 1 error, 2 usage error, 3 paused on a conflict (--once)
`;

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

const OPTIONS = {
  branch: { type: 'string' },
  interval: { type: 'string' },
  debounce: { type: 'string' },
  once: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  'no-push': { type: 'boolean' },
  quiet: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

/** Parses pairsync's argv (without node and the script path). Throws UsageError. */
export function parseArgs(argv) {
  let values;
  try {
    ({ values } = parseNodeArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false }));
  } catch (error) {
    throw new UsageError(describeParseError(error));
  }
  const { branch } = values;
  if (branch !== undefined && (branch === '' || branch.startsWith('-'))) {
    throw new UsageError(`invalid --branch value ${JSON.stringify(branch)}`);
  }
  return {
    branch: branch ?? null,
    intervalMs: parseInterval(values.interval),
    debounceMs: parseDebounce(values.debounce),
    once: values.once === true,
    dryRun: values['dry-run'] === true,
    push: values['no-push'] !== true,
    quiet: values.quiet === true,
    help: values.help === true,
  };
}

function parseInterval(raw) {
  if (raw === undefined) return DEFAULT_INTERVAL_MS;
  const ms = /^\d+(\.\d+)?$/.test(raw) ? Math.ceil(Number(raw) * 1000) : NaN;
  if (!(ms > 0 && ms <= MAX_TIMER_MS)) {
    throw new UsageError(`--interval must be a positive number of seconds, got ${JSON.stringify(raw)}`);
  }
  return ms;
}

function parseDebounce(raw) {
  if (raw === undefined) return DEFAULT_DEBOUNCE_MS;
  const ms = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(ms >= 0 && ms <= MAX_TIMER_MS)) {
    throw new UsageError(`--debounce must be a whole number of milliseconds, got ${JSON.stringify(raw)}`);
  }
  return ms;
}

function describeParseError(error) {
  const quoted = /'([^']+)'/.exec(error.message)?.[1];
  if (error.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' && quoted) return `unknown option ${quoted}`;
  if (error.code === 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL' && quoted) return `unexpected argument ${quoted}`;
  return error.message.split('\n')[0];
}
