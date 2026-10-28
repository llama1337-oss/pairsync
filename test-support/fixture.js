import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Git, formatArgs } from '../src/git.js';
import { createLogger } from '../src/log.js';
import { Syncer, preflight } from '../src/sync.js';

export const BIN = fileURLToPath(new URL('../bin/pairsync.js', import.meta.url));

/**
 * Environment for every git and pairsync process a test starts: the machine's global and
 * system git config are ignored (identity, autocrlf, hooks, merge options all come from
 * the fixture), git never searches above the fixture root, and no GIT_* variable from an
 * outer git hook can redirect git to another repository.
 */
function hermeticEnv(root) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase();
    if (value === undefined || upper.startsWith('GIT_') || upper === 'PAIRSYNC_HOST' || upper === 'NO_COLOR') continue;
    env[key] = value;
  }
  env.GIT_CONFIG_GLOBAL = path.join(root, 'global.gitconfig');
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CEILING_DIRECTORIES = path.dirname(root);
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

function execGit(cwd, args, env) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, env, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout, stderr });
    });
  });
}

/** Runs the real pairsync CLI in `cwd` and collects its output. */
export function runCli(args, { cwd, env, timeoutMs = 60_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd, env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`pairsync ${args.join(' ')} did not exit within ${timeoutMs}ms\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** A logger writing into an array, for in-process Syncer and daemon tests. */
export function captureLog() {
  const lines = [];
  const log = createLogger({
    stream: {
      write(chunk) {
        lines.push(...chunk.split('\n').filter(Boolean));
      },
    },
  });
  return { log, lines };
}

/** Resolves with the next daemon cycle result matching `predicate`. */
export function nextCycle(daemon, predicate = () => true, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const onCycle = (result) => {
      if (!predicate(result)) return;
      clearTimeout(timer);
      daemon.events.off('cycle', onCycle);
      resolve(result);
    };
    const timer = setTimeout(() => {
      daemon.events.off('cycle', onCycle);
      reject(new Error(`no matching sync cycle within ${timeoutMs}ms`));
    }, timeoutMs);
    daemon.events.on('cycle', onCycle);
  });
}

export class Fixture {
  constructor(root) {
    this.root = root;
    this.env = hermeticEnv(root);
    this.origin = path.join(root, 'origin.git');
    this.noHooks = path.join(root, 'no-hooks');
  }

  dir(name) {
    return path.join(this.root, name);
  }

  /** `git <args>` in clone `name` (or an absolute directory); throws on failure. */
  async git(name, ...args) {
    const cwd = path.isAbsolute(name) ? name : this.dir(name);
    const result = await execGit(cwd, args, this.env);
    if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd} (${result.code}): ${result.stderr}`);
    return result.stdout.replace(/\n$/, '');
  }

  /** `git <args>` without throwing, for commands expected to fail. */
  gitResult(name, ...args) {
    return execGit(path.isAbsolute(name) ? name : this.dir(name), args, this.env);
  }

  file(name, relative) {
    return path.join(this.dir(name), ...relative.split('/'));
  }

  async write(name, relative, content) {
    const file = this.file(name, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }

  read(name, relative) {
    return fs.readFile(this.file(name, relative), 'utf8');
  }

  head(name) {
    return this.git(name, 'rev-parse', 'HEAD');
  }

  originTip(branch = 'main') {
    return this.git(this.origin, 'rev-parse', `refs/heads/${branch}`);
  }

  async commitCount(name, rev = 'HEAD') {
    return Number(await this.git(name, 'rev-list', '--count', rev));
  }

  async addClone(name) {
    await this.git(
      this.root,
      'clone',
      '--quiet',
      '-c', `user.name=${name}`,
      '-c', `user.email=${name}@example.test`,
      '-c', 'commit.gpgsign=false',
      '-c', 'core.autocrlf=false',
      '-c', `core.hooksPath=${this.noHooks}`,
      this.origin,
      this.dir(name),
    );
    return this.dir(name);
  }

  /** One `pairsync --once` cycle in clone `name`, identified as host `host` (null = real hostname). */
  sync(name, args = [], { host = name, env = {} } = {}) {
    const childEnv = { ...this.env, ...env };
    if (host !== null) childEnv.PAIRSYNC_HOST = host;
    return runCli(['--once', '--debounce', '0', ...args], { cwd: this.dir(name), env: childEnv });
  }

  /** An in-process Syncer for clone `name`, for tests that inspect results and the git argv log. */
  async syncer(name, { host = name, push = true, dryRun = false, debounceMs = 0, now } = {}) {
    const { log, lines } = captureLog();
    const git = new Git({
      cwd: this.dir(name),
      env: this.env,
      dryRun,
      onDryRun: (args) => log.info(`[dry-run] git ${formatArgs(args)}`),
    });
    const repo = await preflight({ git });
    const syncer = new Syncer({ git, ...repo, host, log, debounceMs, push, ...(now ? { now } : {}) });
    return { syncer, git, repo, log, lines };
  }
}

/**
 * Builds a bare `origin.git` whose `main` holds one seed commit with `files`
 * (README.md is always added), then clones it once per name in `clones`.
 * Everything lives in one mkdtemp directory that is removed when the test ends.
 */
export async function createFixture(t, { clones = ['a', 'b'], files = {} } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pairsync-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const fixture = new Fixture(root);
  await fs.writeFile(fixture.env.GIT_CONFIG_GLOBAL, '');
  await fs.mkdir(fixture.noHooks);

  await fixture.git(root, 'init', '--quiet', '--bare', '--initial-branch=main', fixture.origin);
  const seed = path.join(root, 'seed');
  await fixture.git(root, 'init', '--quiet', '--initial-branch=main', seed);
  for (const [relative, content] of Object.entries({ 'README.md': '# fixture\n', ...files })) {
    const file = path.join(seed, ...relative.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  await fixture.git(seed, 'add', '-A');
  await fixture.git(
    seed,
    '-c', 'user.name=seed',
    '-c', 'user.email=seed@example.test',
    '-c', 'commit.gpgsign=false',
    '-c', 'core.autocrlf=false',
    'commit', '--quiet', '-m', 'initial commit',
  );
  await fixture.git(seed, 'push', '--quiet', fixture.origin, 'main');
  await fs.rm(seed, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

  for (const name of clones) await fixture.addClone(name);
  return fixture;
}
