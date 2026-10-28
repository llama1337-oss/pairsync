# pairsync

[![CI](https://github.com/llama1337-oss/pairsync/actions/workflows/ci.yml/badge.svg)](https://github.com/llama1337-oss/pairsync/actions/workflows/ci.yml)

Two people, two machines, one git repository, and an AI coding agent editing files on each
side. pairsync is a small daemon each person runs inside their own clone: it watches the
worktree, commits what changed after a short quiet period, fetches the other side's work,
merges it, and pushes — continuously, through the GitHub remote both clones already share.
Neither agent has to know the other exists, and neither side's edits get thrown away: every
git command pairsync runs is checked against an allowlist first, so it cannot reset, rebase,
checkout, stash, clean or force-push over anyone's work.

## Requirements

- Node.js `>=20` (the `engines` field in `package.json`); no dependencies, so there is
  nothing to install beyond Node itself.
- git 2.31 or newer on `PATH` — pairsync shells out to the real binary, and refuses to start
  on anything older. (Running the test suite needs git 2.32 or newer.)
- A git clone with an `origin` remote that both people can push to, with the branch you want
  to sync already published (`git push -u origin main` once).
- A commit identity in that clone: `git config user.name "..."` and
  `git config user.email "..."`. pairsync refuses to start without one.

## Install

From a checkout of this repository:

```sh
npm install -g .
```

That puts a `pairsync` command on your `PATH` (the `bin` entry is `pairsync` ->
`./bin/pairsync.js`). `npm install` has no dependencies to fetch, so it is instant and
works offline.

If you would rather not install anything globally, run the entry point directly from the
synced repository — pairsync always operates on the git repository containing the current
working directory, not the one containing the script:

```sh
cd /path/to/shared-repo
node /path/to/pairsync/bin/pairsync.js
```

Inside this repository itself, `npm start` is the same thing.

## Two-machine setup

Both people, on their own machine:

```sh
git clone <url of the repo you two share>
cd <repo>
pairsync
```

That is the whole setup. Leave it running in a terminal and work (or let an agent work) in
the repo as usual. Output looks like this:

```
14:02:11 watching /home/you/shared-repo as laptop: syncing main with origin/main (debounce 1500ms, poll every 10s)
14:02:11 up to date
14:03:24 committed 2 files: src/parser.js, src/tokens.js
14:03:25 pushed 1 commit to origin/main
14:04:02 fetched 1 new commit from origin/main
14:04:02 fast-forwarded to origin/main (1 commit)
14:06:40 WARN both you and desktop are editing src/parser.js — coordinate before continuing
14:07:15 merged 1 commit from origin/main
14:07:16 pushed 1 commit to origin/main
```

Every line is timestamped `HH:MM:SS`. Routine lines are printed once per state change rather
than once per poll, so an idle repo stays quiet. Stop with Ctrl+C:

```
14:20:03 stopping after the current cycle (press Ctrl+C again to quit immediately)
14:20:03 stopped
```

Note that pairsync commits **everything** git considers a change in the worktree
(`git add -A`, untracked files included), minus whatever your `.gitignore` excludes. Keep
build output, secrets and scratch files git-ignored.

## Options

| Flag | Default | What it does |
| --- | --- | --- |
| `--branch <name>` | current branch | Branch to sync. It must already be the checked-out branch; pairsync never switches branches, it refuses to start instead. |
| `--interval <sec>` | `10` | Backstop poll interval in seconds. Fractional values are allowed; it is a floor under the filesystem watcher, not the main trigger. |
| `--debounce <ms>` | `1500` | Quiet period after the last file change before committing, so a burst of agent writes becomes one commit. A commit is never deferred longer than `max(30s, 3 × debounce)`. |
| `--once` | off | Run one full sync cycle, then exit. Useful in scripts and hooks. |
| `--dry-run` | off | Print the git commands that would change something, run none of them. |
| `--no-push` | off | Commit and merge locally, never push. Held commits are reported as `keeping N commits local (--no-push)`. |
| `--quiet` | off | Print only warnings, conflicts and errors. |
| `-h`, `--help` | — | Print usage and exit 0. |

Both `--flag value` and `--flag=value` forms work. Unknown flags, positional arguments and
invalid values are usage errors.

Environment:

| Variable | Effect |
| --- | --- |
| `PAIRSYNC_HOST` | Name for this machine in commit messages and in `.pairsync-shared/<name>.json`. Defaults to the hostname; set it when both machines have the same hostname. |
| `NO_COLOR` | Any value disables colored output. Color is only used when stdout is a TTY anyway. |

Exit codes: `0` ok, `1` error, `2` usage error, `3` paused on a conflict (with `--once`).

Commits are made as `pairsync: <host> <ISO-8601 UTC>` with the changed paths listed in the
body (up to 10, then `- ... and N more`).

## It never overwrites your work

This is the whole point of the tool, so it is enforced structurally rather than by care.

- **Commit first.** A cycle commits local changes *before* it fetches or merges, so an
  incoming merge can never land on top of uncommitted edits. If the worktree changes while
  pairsync is waiting out the debounce, it re-checks the state before staging.
- **Merge only.** The only integration command is
  `git merge --no-edit --ff --no-autostash origin/<branch>`. It fast-forwards when it can and
  makes a real merge commit when it cannot. There is no rebase, no reset, no autostash.
  A configured `branch.<name>.mergeOptions` is cleared for that invocation, so a setting like
  `-X ours` cannot silently drop the other person's side.
- **One guard, every command.** All git invocations go through a single helper,
  `checkGitArgs` in `src/git.js`, called by `Git#run` before anything is spawned. It is an
  allowlist (`version`, `rev-parse`, `rev-list`, `status`, `ls-tree`, `ls-remote`, `var`,
  `diff`, `show`, `remote get-url`, `add`, `commit`, `fetch`, `merge`, `push`) plus an
  explicit ban list: `reset`, `checkout`, `restore`, `switch`, `clean`, `rebase`, `pull`,
  `stash`, `gc`, `prune`, `reflog`, `branch`, `update-ref`, `filter-branch`, `rm`. Dangerous
  arguments to otherwise allowed commands are refused too — any form of force push,
  `push --delete/--mirror/--prune`, `fetch --force/--update-head-ok`, `merge --abort/--quit`,
  merge strategy overrides, `commit --amend/--allow-empty`, `add --force`. The refusal names
  the danger, e.g. `refusing to run "git push --force origin main": push --force is a force push`.
  The guard applies in `--dry-run` too.
- **A rejected push is never forced.** If origin moved while pushing, pairsync fetches,
  merges and retries, up to 3 attempts, then gives up until the next cycle.
- **Conflicts stop everything, loudly.** Nothing is committed, merged or pushed while the
  repo has unmerged paths — or while any merge, rebase, cherry-pick or revert is in progress,
  or while HEAD is on a different branch. pairsync never resolves, commits or aborts a merge
  for you. It prints the paused block once, keeps polling, and prints
  `RESUMED: nothing is blocking sync any more; syncing again` as soon as you are done.

## Who's editing what

Each machine owns exactly one tracked file, `.pairsync-shared/<host>.json`, written and
committed along with your changes. It records the repo-relative paths that machine touched
in the last 15 minutes, with timestamps, sorted for a small diff:

```json
{
  "host": "laptop",
  "lastSeen": "2026-10-28T14:03:24.512Z",
  "paths": {
    "src/parser.js": "2026-10-28T14:03:24.512Z"
  }
}
```

One file per machine means these files never conflict with each other. After each fetch,
pairsync reads the other machines' files out of `origin/<branch>` and compares them with your
own recent paths. An overlap is a warning, never a block:

```
14:06:40 WARN both you and desktop are editing src/parser.js — coordinate before continuing
```

It is repeated only when the other side's claim changes, not on every poll. Entries older
than 15 minutes are pruned.

`.pairsync-shared/` must stay **tracked** — it is how the two sides see each other. The
`.gitignore` here deliberately does not ignore it. `.pairsync/` (no `-shared`) is reserved
for machine-local state and *is* git-ignored; this version writes nothing there.

## When a conflict happens

Both agents edit the same lines of the same file. One side pushes first; the other side's
merge conflicts, and that side's pairsync pauses:

```
14:11:02 PAUSED: conflict merging origin/main: 1 unmerged path. Nothing will be committed, merged or pushed until it is resolved.
           both modified:  src/parser.js
         To resolve it without losing either person's work:
           1. edit each conflicted file and replace every <<<<<<< ======= >>>>>>> block with text that keeps both sides
           2. git add -- src/parser.js
           3. git commit --no-edit
         pairsync resumes automatically once the merge is committed.
```

Do exactly that: the conflict markers are left in your worktree untouched, nothing has been
pushed, and your own work is already committed (commit-first), so it cannot be lost by the
merge. Deleted/modified conflicts get a tailored step naming both choices, for example:

```
  2. src/old.js was deleted by them: keep it with `git add -- src/old.js`, or delete it with `git rm -- src/old.js`
```

Once you run `git commit --no-edit`, the next cycle prints `RESUMED: ...` and pushes the
merge. The other machine fetches it and fast-forwards. Nothing else is required.

The same pause shows up for a merge you started yourself, for a rebase or cherry-pick in
progress ("Finish it with `git rebase --continue`"), and for a detached HEAD or a different
checked-out branch. In every case pairsync waits for you and resumes on its own.

## Limitations

- It is git-based, so sync latency is seconds, not keystrokes: debounce, then commit, then a
  network round trip. It is not an operational-transform editor and two people typing in the
  same function within the same second will still produce a conflict.
- Binary files conflict as whole files. Git cannot merge them, so one of you has to pick a
  side by hand.
- Both people need push rights to the same branch on the same remote. There is no
  fork/pull-request mode.
- It never force-pushes and never rewrites history, so a history that has genuinely diverged
  (someone rebased or force-pushed the shared branch elsewhere) needs manual attention; the
  push will keep being rejected until a human sorts it out.
- Commits are noisy by design: one machine-authored commit per debounced burst, with
  `.pairsync-shared/` updates attached. Squash before merging the branch anywhere that cares.
- Everything not git-ignored gets committed, including secrets you forgot to ignore.
- `fs.watch` with `recursive: true` is the change trigger; where that is unavailable,
  pairsync says so and falls back to the poll interval.

## Development

```sh
npm test
```

`node --test` runs `test/**/*.test.js` with no dependencies. The suite drives the real `git`
binary against throwaway fixture repositories (a bare "origin" plus two clones), covering:
argument parsing and usage/exit codes (`cli.test.js`); the startup refusals — not a repo, bare
repo, detached HEAD, no origin, missing remote branch, mid-merge/rebase/cherry-pick
(`preflight.test.js`); the guard, including that every command pairsync actually runs passes
it and every banned operation is refused (`git-guard.test.js`); debounce and pause/resume
behaviour of the daemon loop (`daemon.test.js`); the activity file format, pruning and overlap
detection (`activity.test.js`); and end-to-end two-clone sync: separate files, same file
different regions, same-line conflict with manual recovery, lost-update protection, rejected
push recovered by fetch+merge+retry, `--dry-run` and `--no-push` (`sync.test.js`).

CI runs the same command on `ubuntu-latest` with Node 20 for every push and pull request to
`main`.

## License

MIT — see [LICENSE](LICENSE).
