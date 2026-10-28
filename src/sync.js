import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  ACTIVITY_DIR,
  DEFAULT_ACTIVITY_WINDOW_MS,
  activityPath,
  findOverlaps,
  parseActivity,
  recentPaths,
  serializeActivity,
  updateActivity,
} from './activity.js';
import { BannedGitCommandError, GitNotFoundError, firstLine } from './git.js';

const MAX_PUSH_ATTEMPTS = 3;
const PUSH_BACKOFF_MS = 400;
const MAX_PATHS_IN_COMMIT = 10;
const MAX_PATHS_IN_LOG = 5;

/**
 * Longest a commit may be deferred while files keep changing; past it the change is
 * committed anyway, so something that writes continuously cannot starve sync forever.
 */
export const maxDeferMs = (debounceMs) => Math.max(30_000, 3 * debounceMs);

/** Files whose presence in the git dir means an operation is in progress. */
const OPERATIONS = [
  ['merge', 'MERGE_HEAD'],
  ['rebase', 'rebase-merge'],
  ['rebase', 'rebase-apply'],
  ['cherry-pick', 'CHERRY_PICK_HEAD'],
  ['revert', 'REVERT_HEAD'],
];

const CONFLICT_KINDS = {
  UU: 'both modified',
  AA: 'both added',
  DD: 'both deleted',
  AU: 'added by us',
  UA: 'added by them',
  DU: 'deleted by us',
  UD: 'deleted by them',
};

export class PreflightError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PreflightError';
  }
}

const plural = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;

const preview = (files) =>
  files.slice(0, MAX_PATHS_IN_LOG).join(', ') +
  (files.length > MAX_PATHS_IN_LOG ? ` (+${files.length - MAX_PATHS_IN_LOG} more)` : '');

const quotePath = (file) => (/^[\w@%+=:,./-]+$/.test(file) ? file : `"${file.replace(/"/g, '\\"')}"`);

/** Splits `git status --porcelain=v1 -z` output into ordinary changes and unmerged (U/AA/DD) entries. */
export function parseStatus(output) {
  const changes = [];
  const unmerged = [];
  for (const entry of output.split('\0')) {
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const isUnmerged = code.includes('U') || code === 'AA' || code === 'DD';
    (isUnmerged ? unmerged : changes).push({ code, path: entry.slice(3) });
  }
  return { changes, unmerged };
}

/** Subject `pairsync: <host> <ISO-8601 UTC>` plus a body listing the changed paths. */
export function commitMessage(host, now, files) {
  const listed = files.slice(0, MAX_PATHS_IN_COMMIT).map((file) => `- ${file}`);
  if (files.length > MAX_PATHS_IN_COMMIT) listed.push(`- ... and ${files.length - MAX_PATHS_IN_COMMIT} more`);
  return [`pairsync: ${host} ${now.toISOString()}`, listed.join('\n')];
}

async function readStatus(git) {
  const { stdout } = await git.run(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']);
  return parseStatus(stdout);
}

async function resolveRef(git, ref) {
  const result = await git.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFailure: true });
  return result.code === 0 ? result.stdout.trim() : null;
}

async function locateOperationFiles(git) {
  const args = ['rev-parse'];
  for (const [, file] of OPERATIONS) args.push('--git-path', file);
  const lines = (await git.run(args)).stdout.split(/\r?\n/).filter(Boolean);
  return OPERATIONS.map(([name], i) => ({ name, file: path.resolve(git.cwd, lines[i]) }));
}

function detectOperation(operationFiles) {
  return operationFiles.find(({ file }) => existsSync(file))?.name ?? null;
}

function describeConflicts(unmerged) {
  return unmerged
    .map(({ code, path: file }) => ({ path: file, code, kind: CONFLICT_KINDS[code] ?? `unmerged (${code})` }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function pauseReason({ branch, operation, unmerged }, expectedBranch) {
  if (operation === 'merge' || (operation === null && unmerged.length > 0)) {
    return unmerged.length > 0 ? { reason: 'conflict', conflicts: describeConflicts(unmerged) } : { reason: 'merge' };
  }
  if (operation !== null) return { reason: 'operation', operation };
  if (branch !== expectedBranch) return { reason: 'branch', branch };
  return null;
}

function resolutionSteps(conflicts) {
  const edited = conflicts.filter(({ code }) => !['DU', 'UD', 'DD'].includes(code)).map(({ path: file }) => quotePath(file));
  const stage = [];
  if (edited.length > 0) stage.push(`git add -- ${edited.join(' ')}`);
  for (const { path: file, code, kind } of conflicts) {
    if (code === 'DU' || code === 'UD') {
      stage.push(`${quotePath(file)} was ${kind}: keep it with \`git add -- ${quotePath(file)}\`, or delete it with \`git rm -- ${quotePath(file)}\``);
    } else if (code === 'DD') {
      stage.push(`git rm -- ${quotePath(file)}`);
    }
  }
  return [
    '  1. edit each conflicted file and replace every <<<<<<< ======= >>>>>>> block with text that keeps both sides',
    ...stage.map((line, i) => (i === 0 ? `  2. ${line}` : `     ${line}`)),
    '  3. git commit --no-edit',
  ];
}

function pauseMessage(pause, branch, remoteName) {
  switch (pause.reason) {
    case 'conflict': {
      const width = Math.max(...pause.conflicts.map(({ kind }) => kind.length)) + 1;
      return [
        `PAUSED: conflict merging ${remoteName}: ${plural(pause.conflicts.length, 'unmerged path')}. Nothing will be committed, merged or pushed until it is resolved.`,
        ...pause.conflicts.map(({ kind, path: file }) => `  ${`${kind}:`.padEnd(width)}  ${file}`),
        "To resolve it without losing either person's work:",
        ...resolutionSteps(pause.conflicts),
        'pairsync resumes automatically once the merge is committed.',
      ];
    }
    case 'merge':
      return [
        'PAUSED: merge in progress: every conflict is resolved but the merge is not committed yet.',
        'Finish it with: git commit --no-edit',
        'pairsync resumes automatically once the merge is committed.',
      ];
    case 'operation':
      return [
        `PAUSED: a ${pause.operation} is in progress. Nothing will be committed, merged or pushed until it finishes.`,
        `Finish it with \`git ${pause.operation} --continue\` (or abort it yourself with \`git ${pause.operation} --abort\`); pairsync resumes automatically afterwards.`,
      ];
    default:
      return [
        `PAUSED: HEAD is ${pause.branch === null ? 'detached' : `on '${pause.branch}'`}, but pairsync syncs '${branch}'.`,
        `pairsync resumes automatically once '${branch}' is checked out again.`,
      ];
  }
}

function describeOperationInProgress(operation, unmerged) {
  if (operation === 'merge') {
    if (unmerged.length === 0) {
      return 'a merge is already in progress and every conflict is resolved; finish it with `git commit --no-edit`, then start pairsync again';
    }
    const files = describeConflicts(unmerged).map(({ path: file }) => file);
    return [
      `a merge is already in progress with ${plural(files.length, 'unmerged path')}: ${files.join(', ')}`,
      'Finish it first (pairsync never commits or aborts a merge for you):',
      ...resolutionSteps(describeConflicts(unmerged)),
      'then start pairsync again.',
    ].join('\n');
  }
  return `a ${operation} is already in progress; finish it with \`git ${operation} --continue\` (or abort it yourself with \`git ${operation} --abort\`), then start pairsync again`;
}

/** Oldest git with everything pairsync relies on (GIT_CONFIG_COUNT is 2.31; merge --no-autostash is 2.27). */
const MIN_GIT_VERSION = [2, 31];

/** Null when `git version` output is new enough (or unparseable), otherwise the found version. */
export function tooOldGit(versionOutput) {
  const match = /git version (\d+)\.(\d+)(\S*)/.exec(versionOutput);
  if (!match) return null;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  const [needMajor, needMinor] = MIN_GIT_VERSION;
  return major < needMajor || (major === needMajor && minor < needMinor) ? `${match[1]}.${match[2]}${match[3]}` : null;
}

/**
 * Startup checks. Each failure throws a PreflightError with a message meant for the user.
 * Re-roots `git` at the repository top level so every later path is repo-relative.
 */
export async function preflight({ git, branch: requested = null }) {
  let version;
  try {
    version = (await git.run(['version'])).stdout;
  } catch (error) {
    if (error instanceof GitNotFoundError) {
      throw new PreflightError('git was not found on PATH; install git and make sure `git --version` works in this terminal');
    }
    throw error;
  }
  const old = tooOldGit(version);
  if (old !== null) {
    throw new PreflightError(`pairsync needs git ${MIN_GIT_VERSION.join('.')} or newer, but found ${old}; please upgrade git`);
  }

  const inside = await git.run(['rev-parse', '--is-inside-work-tree'], { allowFailure: true });
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    const why = firstLine(inside.stderr);
    throw new PreflightError(
      `${git.cwd} is not inside a git repository work tree${why ? ` (git: ${why})` : ''}; run pairsync from a clone of the shared repository`,
    );
  }
  const root = path.resolve((await git.run(['rev-parse', '--show-toplevel'])).stdout.trim());
  git.cwd = root;

  const operationFiles = await locateOperationFiles(git);
  const operation = detectOperation(operationFiles);
  if (operation !== null) {
    throw new PreflightError(describeOperationInProgress(operation, (await readStatus(git)).unmerged));
  }

  const head = await git.run(['rev-parse', '--symbolic-full-name', 'HEAD'], { allowFailure: true });
  if (head.code !== 0) throw new PreflightError('HEAD has no commits yet; check out the shared branch from origin first');
  const ref = head.stdout.trim();
  if (!ref.startsWith('refs/heads/')) {
    throw new PreflightError('HEAD is detached (not on a branch); check out the shared branch, e.g. `git switch main`, then start pairsync again');
  }
  const branch = ref.slice('refs/heads/'.length);
  if (requested !== null && requested !== branch) {
    throw new PreflightError(
      `--branch is '${requested}' but HEAD is on '${branch}'; pairsync never switches branches, so run \`git switch ${requested}\` first or drop --branch`,
    );
  }

  const origin = await git.run(['remote', 'get-url', 'origin'], { allowFailure: true });
  if (origin.code !== 0) {
    throw new PreflightError("this repository has no 'origin' remote; add the shared remote with `git remote add origin <url>`");
  }

  if ((await resolveRef(git, `refs/remotes/origin/${branch}`)) === null) {
    const listed = await git.run(['ls-remote', '--exit-code', 'origin', `refs/heads/${branch}`], { allowFailure: true });
    if (listed.code === 2) {
      throw new PreflightError(
        `origin has no branch '${branch}', so origin/${branch} cannot be resolved; publish it once with \`git push -u origin ${branch}\``,
      );
    }
    if (listed.code !== 0) {
      throw new PreflightError(
        `cannot resolve origin/${branch}: it was never fetched and origin is unreachable (${firstLine(listed.stderr) || `exit code ${listed.code}`})`,
      );
    }
  }

  const identity = await git.run(['var', 'GIT_COMMITTER_IDENT'], { allowFailure: true });
  if (identity.code !== 0) {
    throw new PreflightError(
      'git does not know who you are; run `git config user.name "Your Name"` and `git config user.email you@example.com` in this repository',
    );
  }

  return { root, branch, operationFiles };
}

async function newestMtime(root, changes) {
  let newest = 0;
  await Promise.all(
    changes.map(async ({ path: file }) => {
      try {
        newest = Math.max(newest, (await fs.lstat(path.join(root, file))).mtimeMs);
      } catch {
        // Deleted since `git status` ran: a deletion is never half-written.
      }
    }),
  );
  return newest;
}

/**
 * One sync cycle = commit local work, fetch, warn about overlapping edits, merge, push.
 * Long-lived in daemon mode: it remembers what it already reported so a terminal shows
 * one line per action instead of repeating itself every poll.
 */
export class Syncer {
  #git;
  #log;
  #root;
  #branch;
  #host;
  #push;
  #dryRun;
  #debounceMs;
  #maxDeferMs;
  #windowMs;
  #now;
  #operationFiles;
  #remoteRef;
  #remoteName;
  #activityFile;
  #activityAbsolute;
  #pauseKey = null;
  #idleReported = false;
  #lastError = null;
  #warned = new Set();
  #unreadable = new Set();
  #heldCommits = null;
  #activityIgnoredReported = false;

  constructor({
    git,
    root,
    branch,
    operationFiles,
    host,
    log,
    debounceMs,
    push = true,
    now = () => new Date(),
  }) {
    this.#git = git;
    this.#log = log;
    this.#root = root;
    this.#branch = branch;
    this.#host = host;
    this.#push = push;
    this.#dryRun = git.dryRun;
    this.#debounceMs = debounceMs;
    this.#maxDeferMs = maxDeferMs(debounceMs);
    this.#windowMs = DEFAULT_ACTIVITY_WINDOW_MS;
    this.#now = now;
    this.#operationFiles = operationFiles;
    this.#remoteRef = `refs/remotes/origin/${branch}`;
    this.#remoteName = `origin/${branch}`;
    this.#activityFile = activityPath(host);
    this.#activityAbsolute = path.join(root, ...this.#activityFile.split('/'));
  }

  /**
   * Runs one cycle. `trigger: 'change'` (a debounced file event) does nothing when the
   * worktree turns out to be clean; `'poll'` always talks to origin.
   * Resolves with a result whose `commands` lists every git argv run in this cycle.
   */
  async cycle({ trigger = 'poll' } = {}) {
    const result = {
      status: 'up-to-date',
      trigger,
      committed: [],
      fetched: 0,
      merged: 0,
      pushed: 0,
      pause: null,
      conflicts: [],
      warnings: [],
      error: null,
      commands: [],
    };
    try {
      await this.#run(result);
      if (result.status !== 'error') this.#lastError = null;
    } catch (error) {
      if (error instanceof BannedGitCommandError) throw error;
      this.#reportError(result, error.message);
    } finally {
      result.commands = this.#git.drainHistory();
    }
    return result;
  }

  async #run(result) {
    const state = await this.#inspect();
    const pause = pauseReason(state, this.#branch);
    if (pause) {
      this.#pause(result, pause);
      return;
    }
    this.#resume();

    // Commit-first: local work is committed before anything is fetched or merged, so an
    // incoming merge can never overwrite uncommitted edits.
    if (state.changes.length > 0) {
      if (!(await this.#commitLocal(result, state.changes))) return;
    } else if (result.trigger === 'change') {
      result.status = 'idle';
      return;
    }

    if (!(await this.#fetch(result))) return;
    if (!(await this.#mergeIfBehind(result))) return;
    await this.#pushIfAhead(result);
    if (result.status === 'error') return;

    const acted = result.committed.length > 0 || result.fetched > 0 || result.merged > 0 || result.pushed > 0;
    result.status = acted ? 'synced' : 'up-to-date';
    if (acted) {
      this.#idleReported = false;
    } else if (!this.#idleReported) {
      this.#idleReported = true;
      this.#log.info('up to date');
    }
  }

  async #inspect() {
    const head = await this.#git.run(['rev-parse', '--symbolic-full-name', 'HEAD'], { allowFailure: true });
    const ref = head.code === 0 ? head.stdout.trim() : '';
    const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null;
    const operation = detectOperation(this.#operationFiles);
    const { changes, unmerged } = await readStatus(this.#git);
    return { branch, operation, changes, unmerged };
  }

  #pause(result, pause) {
    result.status = 'paused';
    result.pause = pause;
    result.conflicts = pause.conflicts ?? [];
    const key = JSON.stringify(pause);
    if (key === this.#pauseKey) return;
    this.#pauseKey = key;
    this.#idleReported = false;
    this.#log.paused(pauseMessage(pause, this.#branch, this.#remoteName));
  }

  #resume() {
    if (this.#pauseKey === null) return;
    this.#pauseKey = null;
    this.#log.resumed('nothing is blocking sync any more; syncing again');
  }

  #reportError(result, message) {
    result.status = 'error';
    result.error = message;
    this.#idleReported = false;
    if (message === this.#lastError) return;
    this.#lastError = message;
    this.#log.error(message);
  }

  /** Waits until no changed file was modified within the debounce window (bounded by maxDefer). */
  async #waitUntilQuiet(changes) {
    const started = Date.now();
    let pending = changes;
    while (pending.length > 0) {
      const elapsed = Date.now() - started;
      const quietFor = Date.now() - (await newestMtime(this.#root, pending));
      if (quietFor >= this.#debounceMs || elapsed >= this.#maxDeferMs) return;
      await delay(Math.min(this.#debounceMs - quietFor, this.#maxDeferMs - elapsed) + 10);
      pending = (await readStatus(this.#git)).changes;
    }
  }

  async #commitLocal(result, changes) {
    await this.#waitUntilQuiet(changes);
    // Re-check right before staging: during the quiet wait the user may have started a merge
    // or switched branches, and committing then would capture the wrong tree.
    const state = await this.#inspect();
    const pause = pauseReason(state, this.#branch);
    if (pause) {
      this.#pause(result, pause);
      return false;
    }
    if (state.changes.length === 0) return true;

    const now = this.#now();
    let files;
    if (this.#dryRun) {
      // The index is never touched in dry-run, so report what `git add -A` would stage.
      files = [...new Set(state.changes.map(({ path: file }) => file))].sort();
      this.#log.info(`[dry-run] would commit ${plural(files.length, 'file')}: ${preview(files)}`);
      await this.#git.run(['add', '-A'], { mutates: true });
      await this.#git.run(['add', '--', this.#activityFile], { mutates: true });
    } else {
      await this.#git.run(['add', '-A'], { mutates: true });
      const staged = (await this.#git.run(['diff', '--cached', '--name-only', '--no-renames', '-z'])).stdout
        .split('\0')
        .filter(Boolean);
      files = staged.filter((file) => file !== this.#activityFile);
      // Nothing stageable (e.g. only a dirty submodule): never create an empty commit.
      if (files.length === 0) return true;

      await this.#recordActivity(files, now);
      const added = await this.#git.run(['add', '--', this.#activityFile], { mutates: true, allowFailure: true });
      if (added.code !== 0 && !this.#activityIgnoredReported) {
        this.#activityIgnoredReported = true;
        this.#log.warn(
          `could not stage ${this.#activityFile} (${firstLine(added.stderr)}); the other side will not see which files you are editing. Is ${ACTIVITY_DIR}/ git-ignored?`,
        );
      }
    }
    const [subject, body] = commitMessage(this.#host, now, files);
    await this.#git.run(['commit', '--quiet', '-m', subject, '-m', body], { mutates: true });
    if (!this.#dryRun) this.#log.info(`committed ${plural(files.length, 'file')}: ${preview(files)}`);
    result.committed = files;
    return true;
  }

  async #readOwnActivity() {
    try {
      return parseActivity(await fs.readFile(this.#activityAbsolute, 'utf8'));
    } catch {
      // Missing or unreadable: this machine's own file is simply rebuilt from scratch.
      return null;
    }
  }

  async #recordActivity(files, now) {
    const next = updateActivity(await this.#readOwnActivity(), {
      host: this.#host,
      now,
      changed: files,
      windowMs: this.#windowMs,
    });
    await fs.mkdir(path.dirname(this.#activityAbsolute), { recursive: true });
    await fs.writeFile(this.#activityAbsolute, serializeActivity(next));
  }

  async #countCommits(range) {
    return Number((await this.#git.run(['rev-list', '--count', range])).stdout.trim());
  }

  async #fetch(result) {
    const before = await resolveRef(this.#git, this.#remoteRef);
    const fetched = await this.#git.run(['fetch', '--quiet', 'origin', `refs/heads/${this.#branch}`], {
      mutates: true,
      allowFailure: true,
    });
    if (fetched.code !== 0) {
      this.#reportError(result, `fetch from origin failed: ${firstLine(fetched.stderr) || `exit code ${fetched.code}`}; will retry`);
      return false;
    }
    const after = await resolveRef(this.#git, this.#remoteRef);
    if (after === null) {
      if (fetched.dryRun) {
        this.#log.info(`[dry-run] ${this.#remoteName} has never been fetched, so there is nothing to merge or push against`);
      } else {
        this.#reportError(result, `${this.#remoteName} does not exist even after fetching; check remote.origin.fetch`);
      }
      return false;
    }
    if (after !== before) {
      const count = await this.#countCommits(before === null ? after : `${before}..${after}`);
      result.fetched += count;
      this.#log.info(`fetched ${plural(count, 'new commit')} from ${this.#remoteName}`);
    }
    await this.#warnAboutOverlaps(result);
    return true;
  }

  async #remoteActivity() {
    const listing = await this.#git.run(['ls-tree', '-r', '-z', '--name-only', this.#remoteRef, '--', ACTIVITY_DIR], {
      allowFailure: true,
    });
    if (listing.code !== 0) return [];
    const others = [];
    for (const file of listing.stdout.split('\0')) {
      const name = file.slice(ACTIVITY_DIR.length + 1);
      if (!file.startsWith(`${ACTIVITY_DIR}/`) || !name.endsWith('.json') || name.includes('/') || file === this.#activityFile) continue;
      const blob = await this.#git.run(['show', `${this.#remoteRef}:${file}`], { allowFailure: true });
      if (blob.code !== 0) continue;
      try {
        others.push({ host: name.slice(0, -'.json'.length), activity: parseActivity(blob.stdout) });
      } catch (error) {
        if (!this.#unreadable.has(file)) {
          this.#unreadable.add(file);
          this.#log.warn(`ignoring ${file} from ${this.#remoteName}: ${error.message}`);
        }
      }
    }
    return others;
  }

  /**
   * Runs after every fetch: warns (never blocks) when another host's activity file claims a
   * path this host also changed within the window. `result.warnings` holds the latest overlaps.
   */
  async #warnAboutOverlaps(result) {
    const others = await this.#remoteActivity();
    result.warnings = [];
    if (others.length === 0) return;
    const now = this.#now();
    const mine = new Set(this.#dryRun ? result.committed : []);
    const own = await this.#readOwnActivity();
    if (own !== null) for (const file of recentPaths(own, now, this.#windowMs)) mine.add(file);

    const current = new Set();
    for (const { host, paths, claims } of findOverlaps(mine, others, now, this.#windowMs)) {
      result.warnings.push({ host, paths });
      const keys = paths.map((file, i) => `${host}\0${file}\0${claims[i]}`);
      const fresh = keys.some((key) => !this.#warned.has(key));
      for (const key of keys) current.add(key);
      if (fresh) this.#log.warn(`both you and ${host} are editing ${paths.join(', ')} — coordinate before continuing`);
    }
    this.#warned = current;
  }

  async #divergence() {
    const { stdout } = await this.#git.run(['rev-list', '--left-right', '--count', `HEAD...${this.#remoteRef}`]);
    const [ahead, behind] = stdout.trim().split(/\s+/).map(Number);
    return { ahead, behind };
  }

  /**
   * `origin/<branch>` reads better in merge messages and conflict markers, but is used only
   * when it really resolves to the remote-tracking ref (a local branch named like it wins).
   */
  async #mergeTarget() {
    const resolved = await this.#git.run(['rev-parse', '--symbolic-full-name', this.#remoteName], { allowFailure: true });
    return resolved.code === 0 && resolved.stdout.trim() === this.#remoteRef ? this.#remoteName : this.#remoteRef;
  }

  /** Fast-forward or true merge only. Returns false when the cycle has to stop here. */
  async #mergeIfBehind(result) {
    const { behind } = await this.#divergence();
    if (behind === 0) return true;
    const merge = await this.#git.run(['merge', '--no-edit', '--ff', '--no-autostash', await this.#mergeTarget()], {
      mutates: true,
      allowFailure: true,
      // A configured branch.<name>.mergeOptions such as `-X ours` would silently drop one side.
      config: { [`branch.${this.#branch}.mergeoptions`]: '' },
    });
    if (merge.dryRun) return true;
    if (merge.code !== 0) {
      const pause = pauseReason(await this.#inspect(), this.#branch);
      if (pause) {
        this.#pause(result, pause);
      } else {
        this.#reportError(
          result,
          `merging ${this.#remoteName} failed: ${firstLine(merge.stderr) || firstLine(merge.stdout) || `exit code ${merge.code}`}; will retry`,
        );
      }
      return false;
    }
    result.merged += behind;
    const fastForward = (await resolveRef(this.#git, 'HEAD')) === (await resolveRef(this.#git, this.#remoteRef));
    this.#log.info(
      fastForward
        ? `fast-forwarded to ${this.#remoteName} (${plural(behind, 'commit')})`
        : `merged ${plural(behind, 'commit')} from ${this.#remoteName}`,
    );
    return true;
  }

  async #pushIfAhead(result) {
    for (let attempt = 1; ; attempt += 1) {
      const { ahead } = await this.#divergence();
      if (ahead === 0) {
        this.#heldCommits = null;
        return;
      }
      if (!this.#push) {
        if (ahead !== this.#heldCommits) {
          this.#heldCommits = ahead;
          this.#log.info(`keeping ${plural(ahead, 'commit')} local (--no-push)`);
        }
        return;
      }
      const refspec = `refs/heads/${this.#branch}:refs/heads/${this.#branch}`;
      const push = await this.#git.run(['push', '--porcelain', 'origin', refspec], { mutates: true, allowFailure: true });
      if (push.dryRun) return;
      if (push.code === 0) {
        result.pushed += ahead;
        this.#log.info(`pushed ${plural(ahead, 'commit')} to ${this.#remoteName}`);
        return;
      }
      const rejected = push.stdout.split(/\r?\n/).some((line) => line.startsWith('!'));
      if (!rejected) {
        this.#reportError(result, `push to origin failed: ${firstLine(push.stderr) || `exit code ${push.code}`}; will retry`);
        return;
      }
      if (attempt >= MAX_PUSH_ATTEMPTS) {
        this.#reportError(
          result,
          `push to ${this.#remoteName} was rejected ${MAX_PUSH_ATTEMPTS} times because it kept moving; will retry next cycle`,
        );
        return;
      }
      // The only recovery from a rejected push is fetch + merge + retry, never a forced push.
      this.#log.info(
        `push rejected because ${this.#remoteName} moved; fetching and merging before attempt ${attempt + 1} of ${MAX_PUSH_ATTEMPTS}`,
      );
      await delay(PUSH_BACKOFF_MS * attempt + Math.floor(Math.random() * PUSH_BACKOFF_MS));
      if (!(await this.#fetch(result))) return;
      if (!(await this.#mergeIfBehind(result))) return;
    }
  }
}
