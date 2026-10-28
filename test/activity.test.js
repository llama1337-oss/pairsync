import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import os from 'node:os';
import test from 'node:test';

import {
  DEFAULT_ACTIVITY_WINDOW_MS,
  findOverlaps,
  hostId,
  parseActivity,
  recentPaths,
  resolveHost,
  serializeActivity,
  updateActivity,
} from '../src/activity.js';
import { createFixture } from '../test-support/fixture.js';

const MINUTE = 60_000;
const at = (base, minutes) => new Date(base.getTime() + minutes * MINUTE);

test('host ids are lowercase, filename-safe and never empty', () => {
  assert.equal(hostId('DESKTOP-BODYDROP'), 'desktop-bodydrop');
  assert.equal(hostId("Alice's MacBook Pro"), 'alice-s-macbook-pro');
  assert.equal(hostId('build.local.'), 'build.local');
  assert.equal(hostId('../..'), 'host');
  assert.equal(hostId('x'.repeat(100)).length, 64);
  assert.equal(resolveHost({ PAIRSYNC_HOST: ' Bob ' }), 'bob');
  assert.equal(resolveHost({}), hostId(os.hostname()));
});

test('updating activity records changed paths and prunes entries older than the window', () => {
  const now = new Date('2026-05-01T12:00:00.000Z');
  const previous = {
    host: 'alice',
    lastSeen: at(now, -20).toISOString(),
    paths: new Map([
      ['stale.txt', at(now, -16).toISOString()],
      ['recent.txt', at(now, -5).toISOString()],
      ['src/app.js', at(now, -14).toISOString()],
    ]),
  };
  const next = updateActivity(previous, { host: 'alice', now, changed: ['src/app.js', 'new.txt'] });
  assert.equal(next.lastSeen, now.toISOString());
  assert.deepEqual(
    [...next.paths],
    [
      ['recent.txt', at(now, -5).toISOString()],
      ['src/app.js', now.toISOString()],
      ['new.txt', now.toISOString()],
    ],
  );
  assert.equal(DEFAULT_ACTIVITY_WINDOW_MS, 15 * MINUTE);
});

test('activity files serialise stably and parse back', () => {
  const activity = {
    host: 'bob',
    lastSeen: '2026-05-01T12:00:00.000Z',
    paths: new Map([
      ['z.txt', '2026-05-01T12:00:00.000Z'],
      ['a/b.txt', '2026-05-01T11:59:00.000Z'],
    ]),
  };
  const text = serializeActivity(activity);
  assert.equal(
    text,
    '{\n  "host": "bob",\n  "lastSeen": "2026-05-01T12:00:00.000Z",\n  "paths": {\n' +
      '    "a/b.txt": "2026-05-01T11:59:00.000Z",\n    "z.txt": "2026-05-01T12:00:00.000Z"\n  }\n}\n',
  );
  const parsed = parseActivity(text);
  assert.equal(parsed.host, 'bob');
  assert.deepEqual([...parsed.paths].sort(), [...activity.paths].sort());

  assert.throws(() => parseActivity('{"host":"x"}'), /not a pairsync activity file/);
  assert.throws(() => parseActivity('<<<<<<< HEAD'), SyntaxError);
  assert.deepEqual([...parseActivity('{"paths":{"ok.txt":"2026-05-01T12:00:00Z","bad.txt":"yesterday","num.txt":5}}').paths.keys()], [
    'ok.txt',
  ]);
});

test('overlaps only count claims inside the window', () => {
  const now = new Date('2026-05-01T12:00:00.000Z');
  const other = {
    host: 'other',
    activity: {
      host: 'other',
      lastSeen: now.toISOString(),
      paths: new Map([
        ['shared.txt', at(now, -2).toISOString()],
        ['old.txt', at(now, -30).toISOString()],
        ['theirs.txt', at(now, -1).toISOString()],
      ]),
    },
  };
  assert.deepEqual(recentPaths(other.activity, now).sort(), ['shared.txt', 'theirs.txt']);
  assert.deepEqual(findOverlaps(new Set(['shared.txt', 'old.txt', 'mine.txt']), [other], now), [
    { host: 'other', paths: ['shared.txt'], claims: [at(now, -2).toISOString()] },
  ]);
  assert.deepEqual(findOverlaps(new Set(['mine.txt']), [other], now), []);
});

test('the activity file is created, committed, pushed and lists the changed paths', async (t) => {
  const fixture = await createFixture(t, { clones: ['a'] });
  await fixture.write('a', 'x.txt', 'x\n');
  await fixture.write('a', 'docs/y.md', 'y\n');
  const result = await fixture.sync('a');
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /committed 2 files: docs\/y\.md, x\.txt/);

  const file = '.pairsync-shared/a.json';
  assert.equal(await fixture.git('a', 'ls-files', '--', file), file, 'the activity file is tracked');
  assert.equal(await fixture.git('a', 'status', '--porcelain'), '', 'and committed together with the change');
  const committed = parseActivity(await fixture.git('a', 'show', `HEAD:${file}`));
  assert.equal(committed.host, 'a');
  assert.match(committed.lastSeen, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.deepEqual([...committed.paths.keys()].sort(), ['docs/y.md', 'x.txt']);
  for (const changedAt of committed.paths.values()) assert.equal(changedAt, committed.lastSeen);
  assert.equal(await fixture.git(fixture.origin, 'show', `main:${file}`), await fixture.git('a', 'show', `HEAD:${file}`));

  const subject = await fixture.git('a', 'log', '-1', '--format=%s');
  assert.match(subject, /^pairsync: a \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.equal((await fixture.git('a', 'log', '-1', '--format=%b')).trim(), '- docs/y.md\n- x.txt');
});

test('without PAIRSYNC_HOST the activity file is named after the machine hostname', async (t) => {
  const fixture = await createFixture(t, { clones: ['a'] });
  await fixture.write('a', 'x.txt', 'x\n');
  const result = await fixture.sync('a', [], { host: null });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const file = `.pairsync-shared/${hostId(os.hostname())}.json`;
  assert.ok(existsSync(fixture.file('a', file)), `${file} exists`);
  const subject = await fixture.git('a', 'log', '-1', '--format=%s');
  assert.ok(subject.startsWith(`pairsync: ${hostId(os.hostname())} `), subject);
});

test('entries beyond the 15 minute window are pruned from the committed activity file', async (t) => {
  const fixture = await createFixture(t, { clones: ['a'] });
  const start = new Date();
  let clock = start;
  const { syncer } = await fixture.syncer('a', { now: () => clock });

  await fixture.write('a', 'first.txt', '1\n');
  assert.equal((await syncer.cycle()).status, 'synced');
  clock = at(start, 10);
  await fixture.write('a', 'second.txt', '2\n');
  assert.equal((await syncer.cycle()).status, 'synced');
  let activity = parseActivity(await fixture.git('a', 'show', 'HEAD:.pairsync-shared/a.json'));
  assert.deepEqual([...activity.paths.keys()].sort(), ['first.txt', 'second.txt']);

  clock = at(start, 20);
  await fixture.write('a', 'third.txt', '3\n');
  assert.equal((await syncer.cycle()).status, 'synced');
  activity = parseActivity(await fixture.git('a', 'show', 'HEAD:.pairsync-shared/a.json'));
  assert.deepEqual(Object.fromEntries(activity.paths), {
    'second.txt': at(start, 10).toISOString(),
    'third.txt': at(start, 20).toISOString(),
  });
  assert.equal(activity.lastSeen, at(start, 20).toISOString());
});
