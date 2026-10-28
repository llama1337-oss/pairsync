import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { tooOldGit } from '../src/sync.js';
import { createFixture, runCli } from '../test-support/fixture.js';

/** Runs `pairsync --once` where it must refuse to start, and checks nothing was touched. */
async function expectRefusal(fixture, cwd, message, args = []) {
  const tipBefore = await fixture.originTip();
  const result = await runCli(['--once', '--debounce', '0', ...args], { cwd, env: { ...fixture.env, PAIRSYNC_HOST: 'a' } });
  assert.equal(result.code, 1, `expected exit 1\n${result.stdout}${result.stderr}`);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, message);
  assert.equal(await fixture.originTip(), tipBefore, 'nothing was pushed');
  return result;
}

/** Gives clone `a` a local branch `side` whose notes.txt edit conflicts with one on `main`. */
async function divergeNotes(fixture) {
  await fixture.git('a', 'switch', '--quiet', '-c', 'side');
  await fixture.write('a', 'notes.txt', 'edited on side\n');
  await fixture.git('a', 'commit', '--quiet', '-am', 'side edit');
  await fixture.git('a', 'switch', '--quiet', 'main');
  await fixture.write('a', 'notes.txt', 'edited on main\n');
  await fixture.git('a', 'commit', '--quiet', '-am', 'main edit');
}

test('refuses to run outside a git repository', async (t) => {
  const fixture = await createFixture(t, { clones: [] });
  const plain = path.join(fixture.root, 'plain');
  await fs.mkdir(plain);
  await expectRefusal(fixture, plain, /^pairsync: .*plain is not inside a git repository work tree/);
});

test('refuses to run in a bare repository', async (t) => {
  const fixture = await createFixture(t, { clones: [] });
  await expectRefusal(fixture, fixture.origin, /is not inside a git repository work tree/);
});

test('refuses to run on a detached HEAD', async (t) => {
  const fixture = await createFixture(t, { clones: ['a'] });
  await fixture.git('a', 'switch', '--quiet', '--detach');
  await expectRefusal(fixture, fixture.dir('a'), /^pairsync: HEAD is detached \(not on a branch\)/);
});

test('refuses to run without an origin remote', async (t) => {
  const fixture = await createFixture(t, { clones: ['a'] });
  await fixture.git('a', 'remote', 'remove', 'origin');
  await expectRefusal(fixture, fixture.dir('a'), /^pairsync: this repository has no 'origin' remote/);
});

test('refuses to run when origin has no matching branch', async (t) => {
  const fixture = await createFixture(t, { clones: ['a'] });
  await fixture.git('a', 'switch', '--quiet', '-c', 'feature');
  await expectRefusal(fixture, fixture.dir('a'), /^pairsync: origin has no branch 'feature', so origin\/feature cannot be resolved/);
});

test('refuses a --branch that is not checked out instead of switching to it', async (t) => {
  const fixture = await createFixture(t, { clones: ['a'] });
  await expectRefusal(fixture, fixture.dir('a'), /^pairsync: --branch is 'dev' but HEAD is on 'main'/, ['--branch', 'dev']);
  assert.equal(await fixture.git('a', 'branch', '--show-current'), 'main');
});

test('refuses to start in the middle of a merge, naming the unmerged paths', async (t) => {
  const fixture = await createFixture(t, { clones: ['a'], files: { 'notes.txt': 'original\n' } });
  await divergeNotes(fixture);
  assert.equal((await fixture.gitResult('a', 'merge', 'side')).code, 1);
  const result = await expectRefusal(fixture, fixture.dir('a'), /^pairsync: a merge is already in progress with 1 unmerged path: notes\.txt/);
  assert.match(result.stderr, /git add -- notes\.txt/);
  assert.match(await fixture.read('a', 'notes.txt'), /<<<<<<< /, 'the conflicted merge was left alone');
});

test('refuses to start in the middle of a rebase', async (t) => {
  const fixture = await createFixture(t, { clones: ['a'], files: { 'notes.txt': 'original\n' } });
  await divergeNotes(fixture);
  assert.notEqual((await fixture.gitResult('a', 'rebase', 'side')).code, 0);
  await expectRefusal(fixture, fixture.dir('a'), /^pairsync: a rebase is already in progress/);
});

test('refuses to start in the middle of a cherry-pick', async (t) => {
  const fixture = await createFixture(t, { clones: ['a'], files: { 'notes.txt': 'original\n' } });
  await divergeNotes(fixture);
  assert.notEqual((await fixture.gitResult('a', 'cherry-pick', 'side')).code, 0);
  await expectRefusal(fixture, fixture.dir('a'), /^pairsync: a cherry-pick is already in progress/);
});

test('refuses to run when git is not on PATH', async (t) => {
  const fixture = await createFixture(t, { clones: ['a'] });
  const emptyBin = path.join(fixture.root, 'empty-bin');
  await fs.mkdir(emptyBin);
  const env = { PAIRSYNC_HOST: 'a' };
  for (const [key, value] of Object.entries(fixture.env)) if (key.toUpperCase() !== 'PATH') env[key] = value;
  env.PATH = emptyBin;
  const result = await runCli(['--once'], { cwd: fixture.dir('a'), env });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /^pairsync: git was not found on PATH/);
});

test('git older than 2.31 is refused by version, newer versions pass', () => {
  assert.equal(tooOldGit('git version 2.25.1\n'), '2.25.1');
  assert.equal(tooOldGit('git version 2.30.9.windows.1'), '2.30.9.windows.1');
  assert.equal(tooOldGit('git version 1.9.5'), '1.9.5');
  assert.equal(tooOldGit('git version 2.31.0'), null);
  assert.equal(tooOldGit('git version 2.46.0.windows.1\n'), null);
  assert.equal(tooOldGit('git version 3.0.0'), null);
  assert.equal(tooOldGit('not a version string'), null);
});
