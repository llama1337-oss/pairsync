import assert from 'node:assert/strict';
import test from 'node:test';

import { BannedGitCommandError, Git, checkGitArgs } from '../src/git.js';
import { createFixture } from '../test-support/fixture.js';

const BANNED = [
  ['reset', '--hard'],
  ['reset', '--soft', 'HEAD~1'],
  ['reset'],
  ['checkout', '--', '.'],
  ['checkout', 'main'],
  ['restore', 'notes.txt'],
  ['restore', '--staged', 'notes.txt'],
  ['clean', '-fd'],
  ['push', '--force'],
  ['push', '-f', 'origin', 'main'],
  ['push', '-uf', 'origin', 'main'],
  ['push', '--force-with-lease'],
  ['push', '--force-with-lease=main:abc123', 'origin', 'main'],
  ['push', '--force-if-includes', 'origin', 'main'],
  ['push', 'origin', '+main'],
  ['push', 'origin', '+refs/heads/main:refs/heads/main'],
  ['push', 'origin', ':main'],
  ['push', '--delete', 'origin', 'main'],
  ['push', '-d', 'origin', 'main'],
  ['push', '--mirror', 'origin'],
  ['push', '--prune', 'origin', 'refs/heads/*:refs/heads/*'],
  ['rebase', 'origin/main'],
  ['pull'],
  ['pull', '--rebase'],
  ['stash'],
  ['stash', 'drop'],
  ['stash', 'clear'],
  ['gc', '--prune=now'],
  ['prune'],
  ['branch', '-D', 'feature'],
  ['switch', '--discard-changes', 'main'],
  ['merge', '--abort'],
  ['merge', '--quit'],
  ['merge', '-s', 'ours', 'origin/main'],
  ['merge', '--strategy=ours', 'origin/main'],
  ['merge', '-Xours', 'origin/main'],
  ['merge', '-X', 'theirs', 'origin/main'],
  ['merge', '--strategy-option=theirs', 'origin/main'],
  ['commit', '--amend', '--no-edit'],
  ['commit', '--allow-empty', '-m', 'nothing'],
  ['fetch', 'origin', 'refs/heads/main:refs/heads/main'],
  ['fetch', '--update-head-ok', 'origin', 'main'],
  ['fetch', '--force', 'origin', 'main'],
  ['add', '--force', 'ignored.log'],
  ['add', '-f', 'ignored.log'],
  ['update-ref', '-d', 'refs/heads/main'],
  ['reflog', 'expire', '--expire=now', '--all'],
  ['filter-branch', '--force'],
  ['rm', '-r', '.'],
  ['config', 'core.hooksPath', '/tmp/hooks'],
  ['remote', 'remove', 'origin'],
  ['-c', 'alias.x=reset --hard', 'x'],
  ['--git-dir=/elsewhere/.git', 'status'],
  [],
];

/** Every git argv shape pairsync itself runs. */
const ALLOWED = [
  ['version'],
  ['rev-parse', '--is-inside-work-tree'],
  ['rev-parse', '--show-toplevel'],
  ['rev-parse', '--git-path', 'MERGE_HEAD', '--git-path', 'rebase-merge'],
  ['rev-parse', '--symbolic-full-name', 'HEAD'],
  ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}'],
  ['remote', 'get-url', 'origin'],
  ['ls-remote', '--exit-code', 'origin', 'refs/heads/main'],
  ['var', 'GIT_COMMITTER_IDENT'],
  ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'],
  ['add', '-A'],
  ['add', '--', '.pairsync-shared/alice.json'],
  ['diff', '--cached', '--name-only', '--no-renames', '-z'],
  ['commit', '--quiet', '-m', 'pairsync: alice 2026-01-01T00:00:00.000Z', '-m', '- notes.txt'],
  ['fetch', '--quiet', 'origin', 'refs/heads/main'],
  ['rev-list', '--left-right', '--count', 'HEAD...refs/remotes/origin/main'],
  ['rev-list', '--count', 'abc..def'],
  ['ls-tree', '-r', '-z', '--name-only', 'refs/remotes/origin/main', '--', '.pairsync-shared'],
  ['show', 'refs/remotes/origin/main:.pairsync-shared/bob.json'],
  ['merge', '--no-edit', '--ff', '--no-autostash', 'origin/main'],
  ['push', '--porcelain', 'origin', 'refs/heads/main:refs/heads/main'],
];

test('every banned operation is refused', () => {
  for (const argv of BANNED) {
    assert.notEqual(checkGitArgs(argv), null, `git ${argv.join(' ')} must be refused`);
  }
});

test("every command pairsync runs passes the guard", () => {
  for (const argv of ALLOWED) {
    assert.equal(checkGitArgs(argv), null, `git ${argv.join(' ')} must be allowed`);
  }
});

test('Git#run throws on a banned argv before anything executes', async (t) => {
  const fixture = await createFixture(t, { clones: ['a'] });
  await fixture.write('a', 'README.md', 'an uncommitted edit that reset --hard would destroy\n');
  await fixture.write('a', 'untracked.txt', 'clean -fd would delete this\n');
  const git = new Git({ cwd: fixture.dir('a'), env: fixture.env });

  const refusals = [
    ['reset', '--hard'],
    ['checkout', '--', 'README.md'],
    ['clean', '-fd'],
    ['push', '--force', 'origin', 'main'],
  ];
  for (const argv of refusals) {
    assert.throws(
      () => git.run(argv),
      (error) => error instanceof BannedGitCommandError && error.args.join(' ') === argv.join(' ') && error.message.includes(argv[0]),
    );
  }

  assert.deepEqual(git.history, [], 'a refused command is never recorded as executed');
  assert.equal(await fixture.read('a', 'README.md'), 'an uncommitted edit that reset --hard would destroy\n');
  assert.equal(await fixture.read('a', 'untracked.txt'), 'clean -fd would delete this\n');
  assert.match(await fixture.git('a', 'status', '--porcelain'), / M README\.md/);
});

test('the guard also applies in dry-run mode', () => {
  const git = new Git({ cwd: '.', dryRun: true });
  assert.throws(() => git.run(['reset', '--hard'], { mutates: true }), BannedGitCommandError);
  assert.deepEqual(git.history, []);
});

test('allowed commands are recorded in the per-cycle history', async (t) => {
  const fixture = await createFixture(t, { clones: ['a'] });
  const git = new Git({ cwd: fixture.dir('a'), env: fixture.env });
  await git.run(['status', '--porcelain=v1', '-z']);
  await git.run(['rev-parse', 'HEAD']);
  assert.deepEqual(git.drainHistory(), [
    { args: ['status', '--porcelain=v1', '-z'], executed: true },
    { args: ['rev-parse', 'HEAD'], executed: true },
  ]);
  assert.deepEqual(git.history, []);
});
