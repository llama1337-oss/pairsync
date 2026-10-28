import os from 'node:os';

/**
 * Shared, tracked directory: each machine owns exactly one file in it,
 * `.pairsync-shared/<host>.json`, so these files can never conflict with each other.
 */
export const ACTIVITY_DIR = '.pairsync-shared';
export const DEFAULT_ACTIVITY_WINDOW_MS = 15 * 60 * 1000;

/** Normalises a machine name into the identifier used in commit messages and the activity file name. */
export function hostId(raw) {
  const id = String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64);
  return id || 'host';
}

/** PAIRSYNC_HOST overrides the hostname, for two machines (or two clones) that share a hostname. */
export function resolveHost(env = process.env) {
  return hostId(env.PAIRSYNC_HOST?.trim() || os.hostname());
}

export function activityPath(host) {
  return `${ACTIVITY_DIR}/${host}.json`;
}

/** Parses an activity file; entries without a valid timestamp are dropped. */
export function parseActivity(text) {
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object' || !data.paths || typeof data.paths !== 'object' || Array.isArray(data.paths)) {
    throw new Error('not a pairsync activity file');
  }
  const paths = new Map();
  for (const [file, changedAt] of Object.entries(data.paths)) {
    if (typeof changedAt === 'string' && Number.isFinite(Date.parse(changedAt))) paths.set(file, changedAt);
  }
  return {
    host: typeof data.host === 'string' ? data.host : null,
    lastSeen: typeof data.lastSeen === 'string' ? data.lastSeen : null,
    paths,
  };
}

/**
 * Adds `changed` (repo-relative paths) to `previous` at `now` and prunes every entry older
 * than the window, so the file never grows beyond what changed in the last `windowMs`.
 */
export function updateActivity(previous, { host, now, changed, windowMs = DEFAULT_ACTIVITY_WINDOW_MS }) {
  const cutoff = now.getTime() - windowMs;
  const paths = new Map();
  for (const [file, changedAt] of previous?.paths ?? []) {
    if (Date.parse(changedAt) >= cutoff) paths.set(file, changedAt);
  }
  const stamp = now.toISOString();
  for (const file of changed) paths.set(file, stamp);
  return { host, lastSeen: stamp, paths };
}

/** Stable serialisation (sorted paths, trailing newline) so the committed diff stays small. */
export function serializeActivity({ host, lastSeen, paths }) {
  const sorted = [...paths].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `${JSON.stringify({ host, lastSeen, paths: Object.fromEntries(sorted) }, null, 2)}\n`;
}

/** Paths changed within the window ending at `now`. */
export function recentPaths(activity, now, windowMs = DEFAULT_ACTIVITY_WINDOW_MS) {
  const cutoff = now.getTime() - windowMs;
  return [...activity.paths].filter(([, changedAt]) => Date.parse(changedAt) >= cutoff).map(([file]) => file);
}

/**
 * For each other host, the paths it claims within the window that are also in `mine`.
 * Only hosts with at least one overlapping path are returned.
 */
export function findOverlaps(mine, others, now, windowMs = DEFAULT_ACTIVITY_WINDOW_MS) {
  const overlaps = [];
  for (const { host, activity } of others) {
    const paths = recentPaths(activity, now, windowMs).filter((file) => mine.has(file)).sort();
    if (paths.length > 0) overlaps.push({ host, paths, claims: paths.map((file) => activity.paths.get(file)) });
  }
  return overlaps;
}
