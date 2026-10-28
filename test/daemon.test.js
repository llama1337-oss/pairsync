import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { startDaemon } from '../src/daemon.js';
import { createFixture, nextCycle } from '../test-support/fixture.js';

test('a burst of writes from an agent becomes exactly one commit', async (t) => {
  const fixture = await createFixture(t, { clones: ['a'] });
  const debounceMs = 800;
  const { syncer, log } = await fixture.syncer('a', { debounceMs });
  const before = await fixture.commitCount('a');
  const daemon = startDaemon({ syncer, root: fixture.dir('a'), debounceMs, intervalMs: 1000, log });
  let result;
  try {
    await nextCycle(daemon);
    const committed = nextCycle(daemon, (cycle) => cycle.committed.length > 0);
    // 200 files in 20 batches with gaps far shorter than the debounce, like an agent rewriting a tree.
    for (let batch = 0; batch < 20; batch += 1) {
      await Promise.all(
        Array.from({ length: 10 }, (_, i) => fixture.write('a', `generated/${batch}/file-${i}.txt`, `batch ${batch} file ${i}\n`)),
      );
      await delay(15);
    }
    result = await committed;
  } finally {
    await daemon.stop();
  }
  assert.equal(result.committed.length, 200);
  assert.equal(await fixture.commitCount('a'), before + 1, 'exactly one commit');
  assert.equal(await fixture.git('a', 'status', '--porcelain'), '');
  assert.equal(await fixture.originTip(), await fixture.head('a'));
});

test('a paused daemon keeps polling without committing, then resumes once the merge is committed', async (t) => {
  const fixture = await createFixture(t, { files: { 'notes.txt': 'hello\n' } });
  await fixture.write('a', 'notes.txt', 'hello from a\n');
  assert.equal((await fixture.sync('a')).code, 0);
  const tipAfterA = await fixture.originTip();

  await fixture.write('b', 'notes.txt', 'hello from b\n');
  const { syncer, log, lines } = await fixture.syncer('b', { debounceMs: 100 });
  const daemon = startDaemon({ syncer, root: fixture.dir('b'), debounceMs: 100, intervalMs: 200, log });
  try {
    const paused = await nextCycle(daemon, (cycle) => cycle.status === 'paused');
    assert.deepEqual(
      paused.conflicts.map(({ path }) => path),
      ['notes.txt'],
    );
    const pausedHead = await fixture.head('b');

    // The agent keeps writing while the conflict is open: nothing may be committed, merged or pushed.
    await fixture.write('b', 'later.txt', 'written while paused\n');
    for (let polls = 0; polls < 3; polls += 1) {
      const cycle = await nextCycle(daemon, ({ trigger }) => trigger === 'poll');
      assert.equal(cycle.status, 'paused');
      assert.deepEqual(
        cycle.commands.filter(({ args }) => !['rev-parse', 'status'].includes(args[0])),
        [],
      );
    }
    assert.equal(await fixture.head('b'), pausedHead);
    assert.equal(await fixture.originTip(), tipAfterA);
    assert.equal(lines.filter((line) => line.includes('PAUSED')).length, 1, 'the PAUSED report is printed once, not every poll');

    await fixture.write('b', 'notes.txt', 'hello from a and b\n');
    await fixture.git('b', 'add', 'notes.txt');
    await fixture.git('b', 'commit', '--quiet', '--no-edit');
    await nextCycle(daemon, (cycle) => cycle.pushed > 0);
  } finally {
    await daemon.stop();
  }
  assert.ok(lines.some((line) => line.includes('RESUMED')));
  assert.equal(await fixture.originTip(), await fixture.head('b'));
  assert.equal(await fixture.git(fixture.origin, 'show', 'main:notes.txt'), 'hello from a and b');
  assert.equal(await fixture.git(fixture.origin, 'show', 'main:later.txt'), 'written while paused');
});
