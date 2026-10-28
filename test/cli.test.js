import assert from 'node:assert/strict';
import os from 'node:os';
import test from 'node:test';

import { DEFAULT_DEBOUNCE_MS, DEFAULT_INTERVAL_MS, USAGE, UsageError, parseArgs } from '../src/cli.js';
import { runCli } from '../test-support/fixture.js';

test('defaults', () => {
  assert.deepEqual(parseArgs([]), {
    branch: null,
    intervalMs: DEFAULT_INTERVAL_MS,
    debounceMs: DEFAULT_DEBOUNCE_MS,
    once: false,
    dryRun: false,
    push: true,
    quiet: false,
    help: false,
  });
  assert.equal(DEFAULT_INTERVAL_MS, 10_000);
  assert.equal(DEFAULT_DEBOUNCE_MS, 1500);
});

test('every flag, in both --flag value and --flag=value form', () => {
  assert.deepEqual(
    parseArgs(['--branch', 'dev', '--interval', '2.5', '--debounce', '250', '--once', '--dry-run', '--no-push', '--quiet']),
    { branch: 'dev', intervalMs: 2500, debounceMs: 250, once: true, dryRun: true, push: false, quiet: true, help: false },
  );
  assert.deepEqual(parseArgs(['--branch=feature/x', '--interval=30', '--debounce=0']), {
    ...parseArgs([]),
    branch: 'feature/x',
    intervalMs: 30_000,
    debounceMs: 0,
  });
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
});

test('invalid values and unknown flags are usage errors', () => {
  const cases = [
    [['--bogus'], /unknown option --bogus/],
    [['--force'], /unknown option --force/],
    [['sync-now'], /unexpected argument sync-now/],
    [['--branch'], /--branch/],
    [['--branch='], /invalid --branch/],
    [['--interval', '0'], /--interval must be a positive number/],
    [['--interval', 'soon'], /--interval must be a positive number/],
    [['--interval=-5'], /--interval must be a positive number/],
    [['--debounce', '1.5'], /--debounce must be a whole number/],
    [['--debounce', 'fast'], /--debounce must be a whole number/],
    [['--once=yes'], /--once/],
  ];
  for (const [argv, message] of cases) {
    assert.throws(() => parseArgs(argv), (error) => error instanceof UsageError && message.test(error.message), argv.join(' '));
  }
});

test('an unknown flag prints usage to stderr and exits 2', async () => {
  const result = await runCli(['--bogus'], { cwd: os.tmpdir(), env: process.env });
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^pairsync: unknown option --bogus\n/);
  assert.ok(result.stderr.includes(USAGE));
});

test('an invalid value exits 2 without touching git', async () => {
  const result = await runCli(['--interval', 'never', '--once'], { cwd: os.tmpdir(), env: process.env });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--interval must be a positive number of seconds/);
});

test('--help prints usage to stdout and exits 0', async () => {
  const result = await runCli(['--help'], { cwd: os.tmpdir(), env: process.env });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, USAGE);
  assert.equal(result.stderr, '');
  for (const flag of ['--branch', '--interval', '--debounce', '--once', '--dry-run', '--no-push', '--quiet', '--help']) {
    assert.ok(USAGE.includes(flag), `usage documents ${flag}`);
  }
});
