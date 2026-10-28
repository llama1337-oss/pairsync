import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { EXIT_PAUSED } from '../src/main.js';
import { commitMessage, parseStatus } from '../src/sync.js';
import { createFixture } from '../test-support/fixture.js';

const ok = (result) => {
  assert.equal(result.code, 0, `expected exit 0\n${result.stdout}${result.stderr}`);
  return result;
};

/** Independent of src/git.js on purpose: a bug in the guard must not hide a banned command here. */
const BANNED_COMMANDS = [
  /^reset\b/,
  /^checkout\b/,
  /^restore\b/,
  /^switch\b/,
  /^clean\b/,
  /^rebase\b/,
  /^pull\b/,
  /^stash\b/,
  /^gc\b/,
  /^prune\b/,
  /^branch\b/,
  /^push\b.*(\s--force|\s--force-with-lease|\s--force-if-includes|\s--delete|\s--mirror|\s--prune|\s-[a-zA-Z]*[fd]\b|\s\+|\s:)/,
  /^merge\b.*(\s--abort|\s--quit|\s--strategy|\s-s\b|\s-X)/,
  /^commit\b.*\s--amend/,
];

test('porcelain status: U/AA/DD entries are unmerged, everything else is an ordinary change', () => {
  const unmergedCodes = ['UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD'];
  const ordinary = [' M', 'M ', 'A ', ' D', 'D ', 'AM', 'MM', 'R ', '??'];
  const output = [...unmergedCodes, ...ordinary].map((code, i) => `${code} dir/file ${i}.txt\0`).join('');
  const { changes, unmerged } = parseStatus(output);
  assert.deepEqual(unmerged.map(({ code }) => code), unmergedCodes);
  assert.deepEqual(changes.map(({ code }) => code), ordinary);
  assert.equal(unmerged[0].path, 'dir/file 0.txt');
  assert.deepEqual(parseStatus(''), { changes: [], unmerged: [] });
});

test('commit messages name the host, the UTC time and a short list of paths', () => {
  const now = new Date('2026-03-04T05:06:07.089Z');
  assert.deepEqual(commitMessage('alice', now, ['a.txt', 'src/b.js']), ['pairsync: alice 2026-03-04T05:06:07.089Z', '- a.txt\n- src/b.js']);
  const many = Array.from({ length: 13 }, (_, i) => `f${i}.txt`);
  const [, body] = commitMessage('bob', now, many);
  assert.equal(body.split('\n').length, 11);
  assert.equal(body.split('\n').at(-1), '- ... and 3 more');
});

test('edits to different files reach both clones', async (t) => {
  const fixture = await createFixture(t);
  await fixture.write('a', 'a.txt', 'written in a\n');
  await fixture.write('b', 'b.txt', 'written in b\n');

  assert.match(ok(await fixture.sync('a')).stdout, /committed 1 file: a\.txt[\s\S]*pushed 1 commit to origin\/main/);
  assert.match(ok(await fixture.sync('b')).stdout, /committed 1 file: b\.txt[\s\S]*merged 1 commit from origin\/main[\s\S]*pushed/);
  assert.match(ok(await fixture.sync('a')).stdout, /fast-forwarded to origin\/main/);

  for (const clone of ['a', 'b']) {
    assert.equal(await fixture.read(clone, 'a.txt'), 'written in a\n');
    assert.equal(await fixture.read(clone, 'b.txt'), 'written in b\n');
  }
  assert.equal(await fixture.head('a'), await fixture.head('b'));
  assert.equal(await fixture.head('a'), await fixture.originTip());
});

test('edits to different regions of one file are merged by git without conflict markers', async (t) => {
  const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
  const fixture = await createFixture(t, { files: { 'shared.txt': `${lines.join('\n')}\n` } });
  await fixture.write('a', 'shared.txt', `${['line 1 (edited in a)', ...lines.slice(1)].join('\n')}\n`);
  await fixture.write('b', 'shared.txt', `${[...lines.slice(0, 9), 'line 10 (edited in b)'].join('\n')}\n`);

  ok(await fixture.sync('a'));
  assert.match(ok(await fixture.sync('b')).stdout, /merged 1 commit from origin\/main/);
  ok(await fixture.sync('a'));

  const expected = `${['line 1 (edited in a)', ...lines.slice(1, 9), 'line 10 (edited in b)'].join('\n')}\n`;
  for (const clone of ['a', 'b']) {
    const content = await fixture.read(clone, 'shared.txt');
    assert.equal(content, expected);
    assert.doesNotMatch(content, /^(<<<<<<<|=======|>>>>>>>)/m);
  }
  assert.equal(await fixture.head('a'), await fixture.head('b'));
});

test('same-line edits pause the second syncer, push nothing, and recover after a manual resolution', async (t) => {
  const fixture = await createFixture(t, { files: { 'notes.txt': 'hello\n' } });
  await fixture.write('a', 'notes.txt', 'hello from a\n');
  await fixture.write('b', 'notes.txt', 'hello from b\n');
  ok(await fixture.sync('a'));
  const tipAfterA = await fixture.originTip();

  const paused = await fixture.sync('b');
  assert.equal(paused.code, EXIT_PAUSED, paused.stdout + paused.stderr);
  assert.match(paused.stdout, /PAUSED: conflict merging origin\/main: 1 unmerged path/);
  assert.match(paused.stdout, /both modified: +notes\.txt/);
  assert.match(paused.stdout, /git add -- notes\.txt/);
  assert.match(paused.stdout, /git commit --no-edit/);
  assert.doesNotMatch(paused.stdout, /^\d\d:\d\d:\d\d pushed/m);
  assert.equal(await fixture.originTip(), tipAfterA, 'nothing was pushed while conflicted');

  const conflicted = await fixture.read('b', 'notes.txt');
  assert.match(conflicted, /^<<<<<<< /m);
  assert.match(conflicted, /hello from a/);
  assert.match(conflicted, /hello from b/);
  assert.equal((await fixture.gitResult('b', 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).code, 0, 'the merge was not aborted');
  assert.match(await fixture.git('b', 'log', '-1', '--format=%s', 'HEAD'), /^pairsync: b /, "b's own edit was committed first");

  await fixture.write('b', 'notes.txt', 'hello from a and b\n');
  await fixture.git('b', 'add', 'notes.txt');
  await fixture.git('b', 'commit', '--quiet', '--no-edit');

  assert.match(ok(await fixture.sync('b')).stdout, /pushed 2 commits to origin\/main/);
  assert.equal(await fixture.originTip(), await fixture.head('b'));
  ok(await fixture.sync('a'));
  assert.equal(await fixture.read('a', 'notes.txt'), 'hello from a and b\n');
  assert.equal(await fixture.head('a'), await fixture.head('b'));
});

test("a configured merge option such as -Xours cannot silently drop the other side's line", async (t) => {
  const fixture = await createFixture(t, { files: { 'notes.txt': 'hello\n' } });
  await fixture.git('b', 'config', 'branch.main.mergeoptions', '-Xours');
  await fixture.write('a', 'notes.txt', 'hello from a\n');
  await fixture.write('b', 'notes.txt', 'hello from b\n');
  ok(await fixture.sync('a'));

  const result = await fixture.sync('b');
  assert.equal(result.code, EXIT_PAUSED, result.stdout + result.stderr);
  const notes = await fixture.read('b', 'notes.txt');
  assert.match(notes, /hello from a/);
  assert.match(notes, /hello from b/);
});

test('a cycle with nothing to do commits nothing and pushes nothing', async (t) => {
  const fixture = await createFixture(t);
  const before = { a: await fixture.head('a'), b: await fixture.head('b'), origin: await fixture.originTip() };

  assert.match(ok(await fixture.sync('a')).stdout, /^\d\d:\d\d:\d\d up to date\n$/);
  assert.match(ok(await fixture.sync('b')).stdout, /^\d\d:\d\d:\d\d up to date\n$/);
  const { syncer } = await fixture.syncer('a');
  const result = await syncer.cycle();
  assert.equal(result.status, 'up-to-date');
  const mutating = result.commands.filter(({ args }) => ['add', 'commit', 'merge', 'push'].includes(args[0]));
  assert.deepEqual(mutating, []);

  assert.deepEqual({ a: await fixture.head('a'), b: await fixture.head('b'), origin: await fixture.originTip() }, before);
});

test('ignored files are never committed', async (t) => {
  const fixture = await createFixture(t, { clones: ['a'], files: { '.gitignore': '*.log\n' } });
  const before = await fixture.head('a');
  await fixture.write('a', 'debug.log', 'noise\n');
  assert.match(ok(await fixture.sync('a')).stdout, /up to date/);
  assert.equal(await fixture.head('a'), before);

  await fixture.write('a', 'real.txt', 'work\n');
  ok(await fixture.sync('a'));
  assert.equal(await fixture.git('a', 'ls-files', '--', 'debug.log'), '');
  assert.equal(await fixture.git('a', 'ls-files', '--', 'real.txt'), 'real.txt');
});

test("lost update: syncing after the other side pushed keeps the other side's commit and content", async (t) => {
  const fixture = await createFixture(t);
  await fixture.write('a', 'a.txt', "a's work\n");
  ok(await fixture.sync('a'));
  const aCommit = await fixture.head('a');

  await fixture.write('b', 'b.txt', "b's work\n");
  ok(await fixture.sync('b'));
  const bCommit = await fixture.git('b', 'log', '-1', '--format=%H', '--grep=^pairsync: b ');
  const tip = await fixture.originTip();

  for (const descendant of [await fixture.head('b'), tip]) {
    assert.equal((await fixture.gitResult('b', 'merge-base', '--is-ancestor', aCommit, descendant)).code, 0, "a's commit is reachable");
    assert.equal((await fixture.gitResult('b', 'merge-base', '--is-ancestor', bCommit, descendant)).code, 0, "b's commit is reachable");
  }
  assert.equal(await fixture.read('b', 'a.txt'), "a's work\n");
  assert.equal(await fixture.git(fixture.origin, 'show', 'main:a.txt'), "a's work");
  assert.equal(await fixture.git(fixture.origin, 'show', 'main:b.txt'), "b's work");
  const all = (await fixture.git('b', 'log', '--all', '--format=%H')).split('\n');
  assert.ok(all.includes(aCommit) && all.includes(bCommit), 'git log --all contains both commits');
});

test('a full cycle through a conflict and its recovery never runs a banned git operation', async (t) => {
  const fixture = await createFixture(t, { files: { 'notes.txt': 'hello\n' } });
  const a = await fixture.syncer('a');
  const b = await fixture.syncer('b');
  const executed = [];

  await fixture.write('a', 'notes.txt', 'hello from a\n');
  const first = await a.syncer.cycle();
  assert.equal(first.status, 'synced');
  executed.push(...first.commands);

  await fixture.write('b', 'notes.txt', 'hello from b\n');
  await fixture.write('b', 'other.txt', 'unrelated work\n');
  const conflicted = await b.syncer.cycle();
  assert.equal(conflicted.status, 'paused');
  assert.deepEqual(conflicted.conflicts, [{ path: 'notes.txt', code: 'UU', kind: 'both modified' }]);
  const order = conflicted.commands.map(({ args }) => args[0]);
  assert.ok(order.indexOf('commit') !== -1 && order.indexOf('commit') < order.indexOf('fetch'), 'local work is committed before fetching');
  assert.ok(order.indexOf('fetch') < order.indexOf('merge'));
  executed.push(...conflicted.commands);

  const stillPaused = await b.syncer.cycle();
  assert.equal(stillPaused.status, 'paused');
  assert.deepEqual(
    stillPaused.commands.filter(({ args }) => !['rev-parse', 'status'].includes(args[0])),
    [],
    'while paused, pairsync only inspects',
  );
  executed.push(...stillPaused.commands);

  await fixture.write('b', 'notes.txt', 'hello from a and b\n');
  await fixture.git('b', 'add', 'notes.txt');
  await fixture.git('b', 'commit', '--quiet', '--no-edit');
  const recovered = await b.syncer.cycle();
  assert.equal(recovered.status, 'synced');
  assert.ok(recovered.pushed > 0);
  executed.push(...recovered.commands);
  executed.push(...(await a.syncer.cycle()).commands);

  assert.ok(executed.length > 30, 'the log covers preflight and every cycle');
  assert.ok(executed.every(({ executed: ran }) => ran));
  const commands = executed.map(({ args }) => args.join(' '));
  assert.deepEqual(
    commands.filter((command) => BANNED_COMMANDS.some((pattern) => pattern.test(command))),
    [],
  );
  assert.ok(commands.some((command) => command.startsWith('merge --no-edit --ff --no-autostash ')));
  assert.ok(commands.filter((command) => command.startsWith('push ')).every((command) => command === 'push --porcelain origin refs/heads/main:refs/heads/main'));
  assert.equal(await fixture.read('a', 'other.txt'), 'unrelated work\n');
});

test('a rejected push is recovered by fetch + merge + retry, never by forcing', async (t) => {
  const fixture = await createFixture(t, { clones: ['a', 'b', 'c'] });
  await fixture.write('c', 'c.txt', 'from c\n');
  await fixture.git('c', 'add', 'c.txt');
  await fixture.git('c', 'commit', '--quiet', '-m', 'commit from c');
  const cCommit = await fixture.head('c');

  // b's pre-push hook pushes c's commit first (once), so b's own push is rejected because
  // origin moved between b's fetch and b's push: the race two live daemons can hit.
  const hooks = path.join(fixture.root, 'b-hooks');
  const marker = path.join(fixture.root, 'raced');
  const shellPath = (file) => file.split(path.sep).join('/');
  await fs.mkdir(hooks);
  await fs.writeFile(
    path.join(hooks, 'pre-push'),
    [
      '#!/bin/sh',
      'unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE',
      `if [ ! -e '${shellPath(marker)}' ]; then`,
      `  : > '${shellPath(marker)}'`,
      `  git -C '${shellPath(fixture.dir('c'))}' push --quiet origin main || exit 1`,
      'fi',
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  await fixture.git('b', 'config', 'core.hooksPath', hooks);
  await fixture.write('b', 'b.txt', 'from b\n');

  const { syncer, lines } = await fixture.syncer('b');
  const result = await syncer.cycle();
  assert.ok(existsSync(marker), 'the competing push happened');
  assert.equal(result.status, 'synced', lines.join('\n'));
  assert.ok(lines.some((line) => line.includes('push rejected because origin/main moved')));

  const argv = result.commands.map(({ args }) => args);
  const pushes = argv.flatMap((args, i) => (args[0] === 'push' ? [i] : []));
  assert.equal(pushes.length, 2);
  const between = argv.slice(pushes[0] + 1, pushes[1]).map((args) => args[0]);
  assert.ok(between.includes('fetch') && between.includes('merge'), 'retry is preceded by fetch + merge');
  for (const i of pushes) assert.deepEqual(argv[i], ['push', '--porcelain', 'origin', 'refs/heads/main:refs/heads/main']);

  const tip = await fixture.originTip();
  assert.equal(tip, await fixture.head('b'));
  assert.equal((await fixture.gitResult('b', 'merge-base', '--is-ancestor', cCommit, tip)).code, 0, "c's commit survived");
  assert.equal(await fixture.git(fixture.origin, 'show', 'main:c.txt'), 'from c');
  assert.equal(await fixture.git(fixture.origin, 'show', 'main:b.txt'), 'from b');
});

test('an overlap with another host is a warning, never a block', async (t) => {
  const fixture = await createFixture(t, { files: { 'shared.txt': 'one\n', 'stale.txt': 'old\n' } });
  const now = Date.now();
  const claims = {
    host: 'other',
    lastSeen: new Date(now).toISOString(),
    paths: {
      'shared.txt': new Date(now - 60_000).toISOString(),
      'stale.txt': new Date(now - 20 * 60_000).toISOString(),
    },
  };
  await fixture.write('b', '.pairsync-shared/other.json', `${JSON.stringify(claims, null, 2)}\n`);
  await fixture.git('b', 'add', '.pairsync-shared/other.json');
  await fixture.git('b', 'commit', '--quiet', '-m', 'activity of another machine');
  await fixture.git('b', 'push', '--quiet', 'origin', 'main');

  await fixture.write('a', 'shared.txt', 'one, edited in a\n');
  await fixture.write('a', 'stale.txt', 'old, edited in a\n');
  const result = ok(await fixture.sync('a'));
  assert.match(result.stdout, /WARN both you and other are editing shared\.txt — coordinate before continuing\n/);
  assert.doesNotMatch(result.stdout, /WARN.*stale\.txt/, 'claims older than the window are ignored');
  assert.match(result.stdout, /pushed/);
  assert.equal(await fixture.git(fixture.origin, 'show', 'main:shared.txt'), 'one, edited in a');
});

test('--dry-run prints the mutating git commands and runs none of them', async (t) => {
  const fixture = await createFixture(t, { clones: ['a'] });
  const head = await fixture.head('a');
  await fixture.write('a', 'draft.txt', 'draft\n');

  const result = ok(await fixture.sync('a', ['--dry-run']));
  assert.match(result.stdout, /\[dry-run\] would commit 1 file: draft\.txt/);
  assert.match(result.stdout, /\[dry-run\] git add -A\n/);
  assert.match(result.stdout, /\[dry-run\] git commit --quiet -m "pairsync: a /);
  assert.match(result.stdout, /\[dry-run\] git fetch --quiet origin refs\/heads\/main\n/);
  assert.equal(await fixture.head('a'), head);
  assert.equal(await fixture.git('a', 'status', '--porcelain'), '?? draft.txt');
  assert.equal(existsSync(fixture.file('a', '.pairsync-shared/a.json')), false);
  assert.equal(await fixture.originTip(), head);
});

test('--no-push commits and merges locally but never pushes', async (t) => {
  const fixture = await createFixture(t, { clones: ['a'] });
  const tip = await fixture.originTip();
  await fixture.write('a', 'local.txt', 'local only\n');

  const result = ok(await fixture.sync('a', ['--no-push']));
  assert.match(result.stdout, /committed 1 file: local\.txt/);
  assert.match(result.stdout, /keeping 1 commit local \(--no-push\)/);
  assert.equal(await fixture.originTip(), tip);
  assert.equal(await fixture.commitCount('a'), 2);
});
