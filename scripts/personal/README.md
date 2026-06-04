# scripts/personal/

Fork-only automation. **Lives on the `personal` branch only — must never reach
an upstream PR.** Add `scripts/personal/` to your mental "do not cherry-pick
into feat/*" list.

## Branching topology this assumes

| Branch | Tracks | Purpose |
|---|---|---|
| `main` | `upstream/main` | read-only mirror of canonical |
| `personal` | `origin/personal` | daily working branch — your living build |
| `feat/<thing>` | `origin/feat/<thing>` | upstream PR scope (branched off `main`) |
| `personal/<thing>` or other typed branches | `origin/<branch>` | fork-only work-in-progress |

One-time setup (already done — keep as a reference):

```bash
git remote add upstream https://github.com/open-gsd/gsd-pi.git   # if missing
git branch --set-upstream-to=upstream/main main                  # critical
```

## sync-upstream.sh

Run weekly (or whenever you want to absorb upstream changes).

```bash
scripts/personal/sync-upstream.sh
```

What it does, in order, with bail-outs on every guardrail:

1. Pre-flight — checks remotes exist, branches exist, `main` tracks
   `upstream/main`, working tree is clean, no in-progress merge/rebase/cherry-pick.
2. Fetches `upstream` and `origin` with `--prune`.
3. Fast-forwards local `main` from `upstream/main`. Refuses non-FF (i.e.
   refuses if local `main` has commits not in upstream — which means you
   accidentally committed to `main`).
4. Pushes the new `main` to `origin/main` (mirror).
5. Saves a backup ref `personal-pre-rebase-<timestamp>`, then rebases
   `personal` on `main`. On conflict, prints the exact recovery commands
   and exits non-zero — your tree is left mid-rebase so you can resume.
6. Force-with-lease pushes `personal` to `origin`.
7. Lists any other local feature branches that have fallen behind `main`.
8. Hints to run `pnpm install` if `pnpm-lock.yaml` changed during the sync.

Returns you to the branch you started on (only on success).

### Recovery from a bad rebase

The backup ref lives at `personal-pre-rebase-<timestamp>`. To roll back:

```bash
git checkout personal
git reset --hard personal-pre-rebase-<timestamp>
git push --force-with-lease origin personal
```

Old backup refs accumulate. Prune occasionally:

```bash
git for-each-ref --format='%(refname:short)' 'refs/heads/personal-pre-rebase-*' \
  | sort | head -n -3 | xargs -I{} git update-ref -d refs/heads/{}
```

## open-upstream-pr.sh

Run from a feat/* (or fix/*, refactor/*, …) branch that has the commits you
want to send upstream. It will not touch your `personal` branch.

```bash
git checkout feat/<thing>
scripts/personal/open-upstream-pr.sh
```

What it does, in order:

1. Branch sanity — refuses if you're on `main` or `personal`, or if the
   branch name doesn't use a valid CONTRIBUTING.md prefix.
2. Working tree clean + no in-progress git ops.
3. `gh` CLI is installed and authenticated, both remotes are configured.
4. Fetches `upstream/main`; offers to rebase if you've fallen behind
   (with a backup ref).
5. Verifies every commit subject between `upstream/main` and `HEAD` matches
   Conventional Commits.
6. Runs `node scripts/secret-scan.mjs --diff upstream/main`.
7. Runs `pnpm run verify:pr` (build:core + typecheck:extensions + test:unit).
   Skip with `--skip-verify` only if you JUST ran it yourself.
8. Pushes to `origin` (`-u` on first push, `--force-with-lease` afterwards).
9. Prompts for a PR title (default = top commit subject) and opens `$EDITOR`
   so you can edit the body. Bullet-list of commits + a test-plan checklist
   are pre-filled. Empty body aborts before hitting the GitHub API.
10. Creates the PR via `gh pr create --repo open-gsd/gsd-pi --base main`.
    If an open PR already exists for `<your-user>:<branch>`, prints its URL
    instead of double-creating.
11. Offers to open the PR in your browser.

### Environment overrides

Both scripts honour these env vars (rare to need):

| Var | Default | What it does |
|---|---|---|
| `UPSTREAM_REMOTE` | `upstream` | name of the canonical remote |
| `ORIGIN_REMOTE` | `origin` | name of your fork's remote |
| `MAIN_BRANCH` | `main` | upstream's default branch |
| `PERSONAL_BRANCH` | `personal` | your daily branch (sync only) |
| `UPSTREAM_REPO` | `open-gsd/gsd-pi` | PR target repo (open-pr only) |
| `EDITOR` | `vi` | editor for PR body (open-pr only) |

### When NOT to use open-upstream-pr.sh

- The branch contains fork-only commits (e.g. `UPSTREAM_REVIEW:A/B/C` markers
  from the cursor-cli plan). Move those to a `personal/*` branch first, or
  cherry-pick only the upstream-safe commits to a clean `feat/*` branch.
- You don't want CI to run. (Verify locally first — this script enforces it.)
- You haven't squashed work-in-progress commits. Run `git rebase -i upstream/main`
  yourself, then re-run.
