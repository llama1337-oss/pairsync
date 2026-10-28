import { execFile } from 'node:child_process';

/**
 * Subcommands pairsync never runs in any form: each can discard, hide or rewrite
 * someone's work. Kept separate from the allowlist below so the refusal names the danger.
 */
const BANNED_SUBCOMMANDS = new Map([
  ['reset', 'reset (any mode) moves the branch and can discard work'],
  ['checkout', 'checkout can overwrite worktree paths (checkout -- <path>)'],
  ['restore', 'restore overwrites worktree paths'],
  ['switch', 'switch can discard local changes (switch --discard-changes)'],
  ['clean', 'clean deletes untracked files'],
  ['rebase', 'rebase rewrites commits the other side already has'],
  ['pull', 'pull can rebase, depending on config'],
  ['stash', 'stash hides local changes and stash drop/clear deletes them'],
  ['gc', 'gc --prune deletes unreachable commits'],
  ['prune', 'prune deletes unreachable objects'],
  ['reflog', 'reflog expire/delete removes recovery points'],
  ['branch', 'branch -D deletes unmerged work'],
  ['update-ref', 'update-ref moves refs without any safety check'],
  ['filter-branch', 'filter-branch rewrites history'],
  ['rm', 'rm deletes worktree files'],
]);

const anyArgs = () => null;

const noOutputFile = (rest) =>
  rest.some((arg) => arg.startsWith('--output')) ? '--output writes files outside git' : null;

/** True for a single-dash short-option cluster (e.g. `-uf`) that contains one of `letters`. */
const shortFlagsInclude = (arg, letters) =>
  /^-[A-Za-z]+$/.test(arg) && [...letters].some((letter) => arg.includes(letter));

/**
 * The only subcommands pairsync may run, each mapped to a check that returns why a
 * particular argument list is unsafe (or null when it is fine).
 */
const ALLOWED_SUBCOMMANDS = new Map([
  ['version', anyArgs],
  ['rev-parse', anyArgs],
  ['rev-list', anyArgs],
  ['status', anyArgs],
  ['ls-tree', anyArgs],
  ['ls-remote', anyArgs],
  ['var', anyArgs],
  ['diff', noOutputFile],
  ['show', noOutputFile],
  ['remote', (rest) => (rest[0] === 'get-url' ? null : 'remote is only allowed as "remote get-url"')],
  [
    'add',
    (rest) =>
      rest.some((arg) => arg === '--force' || shortFlagsInclude(arg, 'f'))
        ? 'add --force would stage ignored files'
        : null,
  ],
  [
    'commit',
    (rest) => {
      if (rest.includes('--amend')) return 'commit --amend rewrites a commit the other side may already have';
      if (rest.includes('--allow-empty')) return 'commit --allow-empty creates empty commits';
      return null;
    },
  ],
  [
    'fetch',
    (rest) => {
      for (const arg of rest) {
        if (arg === '--force' || arg === '--update-head-ok' || shortFlagsInclude(arg, 'fu')) {
          return `fetch ${arg} can overwrite local branches`;
        }
        if (!arg.startsWith('-') && arg.includes(':')) return 'fetch <src>:<dst> writes local refs directly';
      }
      return null;
    },
  ],
  [
    'merge',
    (rest) => {
      for (const arg of rest) {
        if (arg === '--abort' || arg === '--quit') return `merge ${arg} throws away the in-progress merge`;
        if (arg.startsWith('--strategy') || /^-[A-Za-z]*[sX]/.test(arg)) {
          return 'merge strategy overrides (-s ours, -X ours/theirs) silently drop one side';
        }
      }
      return null;
    },
  ],
  [
    'push',
    (rest) => {
      for (const arg of rest) {
        if (arg === '--force' || arg.startsWith('--force-with-lease') || arg === '--force-if-includes' || /^-[A-Za-z]*f/.test(arg)) {
          return `push ${arg} is a force push`;
        }
        if (arg.startsWith('+')) return `push ${arg} is a force push (+refspec)`;
        if (arg === '--delete' || /^-[A-Za-z]*d/.test(arg) || arg.startsWith(':')) {
          return `push ${arg} deletes a remote branch`;
        }
        if (arg === '--mirror' || arg === '--prune') return `push ${arg} can delete remote branches`;
      }
      return null;
    },
  ],
]);

/**
 * Why `args` must not be run, or null when it is allowed. Every git invocation pairsync
 * makes is checked here first (see Git#run), so the no-clobber rules are structural.
 */
export function checkGitArgs(args) {
  if (!Array.isArray(args) || args.length === 0 || args.some((arg) => typeof arg !== 'string')) {
    return 'argv must be a non-empty array of strings';
  }
  const [subcommand, ...rest] = args;
  if (subcommand.startsWith('-')) return `global option ${subcommand} before the subcommand is not allowed`;
  const banned = BANNED_SUBCOMMANDS.get(subcommand);
  if (banned) return banned;
  const check = ALLOWED_SUBCOMMANDS.get(subcommand);
  if (!check) return `"${subcommand}" is not a git command pairsync is allowed to run`;
  return check(rest);
}

export function formatArgs(args) {
  return args.map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : JSON.stringify(arg))).join(' ');
}

export class BannedGitCommandError extends Error {
  constructor(args, reason) {
    const shown = Array.isArray(args) ? formatArgs(args.map(String)) : String(args);
    super(`refusing to run "git ${shown}": ${reason}`);
    this.name = 'BannedGitCommandError';
    this.args = Array.isArray(args) ? [...args] : args;
    this.reason = reason;
  }
}

export class GitNotFoundError extends Error {
  constructor() {
    super('git was not found on PATH');
    this.name = 'GitNotFoundError';
  }
}

export class GitError extends Error {
  constructor(args, { code, signal, stdout, stderr }) {
    const detail = firstLine(stderr) || firstLine(stdout) || (signal ? `killed by ${signal}` : `exit code ${code}`);
    super(`git ${args[0]} failed: ${detail}`);
    this.name = 'GitError';
    this.args = [...args];
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

export function firstLine(text) {
  return (text ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
}

/** Variables that would point git at a different repository than the one in `cwd`. */
const REPOSITORY_OVERRIDES = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
]);

function gitEnvironment(base) {
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !REPOSITORY_OVERRIDES.has(key.toUpperCase())) env[key] = value;
  }
  // A daemon has nobody watching for a credential prompt: fail and report instead of hanging.
  env.GIT_TERMINAL_PROMPT = '0';
  // Background `git status` must not grab index.lock out from under the user's own git commands.
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_MERGE_AUTOEDIT = 'no';
  return env;
}

/** Per-invocation config overrides via GIT_CONFIG_COUNT, appended after any the caller already set. */
function withConfig(env, config) {
  const out = { ...env };
  let index = Number.parseInt(out.GIT_CONFIG_COUNT ?? '', 10);
  if (!Number.isInteger(index) || index < 0) index = 0;
  for (const [key, value] of Object.entries(config)) {
    out[`GIT_CONFIG_KEY_${index}`] = key;
    out[`GIT_CONFIG_VALUE_${index}`] = value;
    index += 1;
  }
  out.GIT_CONFIG_COUNT = String(index);
  return out;
}

/**
 * The single gateway to the git binary. Every argv is validated by checkGitArgs before
 * anything is spawned and recorded in `history` (drained once per sync cycle).
 */
export class Git {
  #env;
  #onDryRun;

  constructor({ cwd, env = process.env, dryRun = false, onDryRun = () => {} }) {
    this.cwd = cwd;
    this.dryRun = dryRun;
    this.history = [];
    this.#env = gitEnvironment(env);
    this.#onDryRun = onDryRun;
  }

  /**
   * Runs `git <args>` with execFile (no shell). Throws BannedGitCommandError synchronously,
   * before spawning, if the argv is not allowed. `mutates` marks commands that change the
   * repository; in dry-run mode those are reported via onDryRun and never executed.
   */
  run(args, { mutates = false, allowFailure = false, config = null } = {}) {
    const reason = checkGitArgs(args);
    if (reason) throw new BannedGitCommandError(args, reason);

    const executed = !(mutates && this.dryRun);
    this.history.push({ args: [...args], executed });
    if (!executed) {
      this.#onDryRun([...args]);
      return Promise.resolve({ code: 0, signal: null, stdout: '', stderr: '', dryRun: true });
    }

    return new Promise((resolve, reject) => {
      const child = execFile(
        'git',
        args,
        {
          cwd: this.cwd,
          env: config ? withConfig(this.#env, config) : this.#env,
          encoding: 'utf8',
          maxBuffer: 256 * 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error && typeof error.code === 'string') {
            reject(error.code === 'ENOENT' ? new GitNotFoundError() : error);
            return;
          }
          const result = { code: error ? error.code ?? null : 0, signal: error?.signal ?? null, stdout, stderr };
          if (result.code !== 0 && !allowFailure) reject(new GitError(args, result));
          else resolve(result);
        },
      );
      if (child.stdin) {
        child.stdin.on('error', () => {});
        child.stdin.end();
      }
    });
  }

  /** Returns every invocation recorded since the last drain and starts a fresh log. */
  drainHistory() {
    const history = this.history;
    this.history = [];
    return history;
  }
}
