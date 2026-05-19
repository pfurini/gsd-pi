#!/usr/bin/env bash
# scripts/personal/sync-upstream.sh
#
# Personal-only. Lives on the `personal` branch — must never reach an upstream PR.
#
# Weekly upstream-sync ritual:
#   1. fetch upstream + origin (with --prune)
#   2. fast-forward local `main` to `upstream/main` (refuses non-FF)
#   3. mirror `main` to `origin/main`
#   4. rebase `personal` on `main`, saving a backup ref first
#   5. force-with-lease push `personal` to `origin`
#   6. list any feat/*/fix/*/etc. branches that have fallen behind `main`
#
# Safe defaults:
#   - bails on dirty working tree, in-progress merge/rebase/cherry-pick
#   - refuses if local `main` doesn't track `upstream/main`
#   - refuses to rewrite `main` if it has diverged from `upstream/main`
#   - `--force-with-lease` (never plain `--force`) on personal push
#   - returns you to the branch you started on (only on full success)
#   - keeps a `personal-pre-rebase-<timestamp>` ref so you can undo the rebase
#
# Usage: scripts/personal/sync-upstream.sh
# Exit 0 = clean sync; non-zero = stopped at a guard (see message).

set -euo pipefail

UPSTREAM="${UPSTREAM_REMOTE:-upstream}"
ORIGIN="${ORIGIN_REMOTE:-origin}"
MAIN="${MAIN_BRANCH:-main}"
PERSONAL="${PERSONAL_BRANCH:-personal}"

# ─── Pretty printing ──────────────────────────────────────────────────────
if [ -t 2 ]; then
  RED=$'\e[31m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; CYAN=$'\e[36m'; DIM=$'\e[2m'; NC=$'\e[0m'
else
  RED=""; GREEN=""; YELLOW=""; CYAN=""; DIM=""; NC=""
fi
say()  { printf '%s== %s ==%s\n' "$CYAN" "$*" "$NC" >&2; }
ok()   { printf '  %s✓%s %s\n'   "$GREEN" "$NC" "$*" >&2; }
warn() { printf '  %s!%s %s\n'   "$YELLOW" "$NC" "$*" >&2; }
err()  { printf '  %s✗%s %s\n'   "$RED" "$NC" "$*" >&2; }
die()  { err "$*"; exit 1; }

# ─── Cleanup / branch restore ─────────────────────────────────────────────
START_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
restore_start_branch() {
  local rc=$?
  local current
  current="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
  if [ "$rc" -eq 0 ] && [ "$current" != "$START_BRANCH" ]; then
    git checkout "$START_BRANCH" 2>/dev/null || true
  fi
}
trap restore_start_branch EXIT

# ─── Move to repo root ────────────────────────────────────────────────────
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# ─── 1. Pre-flight guards ─────────────────────────────────────────────────
say "Pre-flight"

git remote get-url "$UPSTREAM" >/dev/null 2>&1 \
  || die "remote '$UPSTREAM' not configured. Run: git remote add $UPSTREAM <url>"
git remote get-url "$ORIGIN" >/dev/null 2>&1 \
  || die "remote '$ORIGIN' not configured."
ok "remotes present ($UPSTREAM, $ORIGIN)"

git show-ref --verify --quiet "refs/heads/$MAIN" \
  || die "local branch '$MAIN' missing."
git show-ref --verify --quiet "refs/heads/$PERSONAL" \
  || die "local branch '$PERSONAL' missing."
ok "local branches present ($MAIN, $PERSONAL)"

main_tracking="$(git for-each-ref --format='%(upstream:short)' "refs/heads/$MAIN")"
if [ "$main_tracking" != "$UPSTREAM/$MAIN" ]; then
  die "local '$MAIN' tracks '${main_tracking:-<nothing>}', expected '$UPSTREAM/$MAIN'.
       Fix once with: git branch --set-upstream-to=$UPSTREAM/$MAIN $MAIN"
fi
ok "$MAIN tracks $UPSTREAM/$MAIN"

# Refuse if working tree is dirty (tracked-file modifications) — untracked files OK.
if ! git diff-index --quiet HEAD --; then
  die "working tree has uncommitted changes. Commit or stash them first."
fi
for inprogress in MERGE_HEAD REBASE_HEAD CHERRY_PICK_HEAD REVERT_HEAD; do
  if [ -e ".git/$inprogress" ]; then
    die "in-progress git operation detected (.git/$inprogress). Finish or abort it first."
  fi
done
if [ -d ".git/rebase-merge" ] || [ -d ".git/rebase-apply" ]; then
  die "in-progress rebase detected. Run: git rebase --continue|--abort"
fi
ok "working tree clean, no in-progress operations"

# Track whether the lockfile changes — surface a hint at the end.
LOCKFILE_BEFORE_SHA="$(git hash-object package-lock.json 2>/dev/null || echo none)"

# ─── 2. Fetch ─────────────────────────────────────────────────────────────
say "Fetch $UPSTREAM and $ORIGIN"
git fetch "$UPSTREAM" --prune --quiet
git fetch "$ORIGIN" --prune --quiet
ok "fetched"

# ─── 3. Fast-forward main from upstream/main ──────────────────────────────
say "Update local $MAIN"
git checkout --quiet "$MAIN"

LOCAL_MAIN_SHA="$(git rev-parse "$MAIN")"
UPSTREAM_MAIN_SHA="$(git rev-parse "$UPSTREAM/$MAIN")"

if [ "$LOCAL_MAIN_SHA" = "$UPSTREAM_MAIN_SHA" ]; then
  ok "$MAIN already at $UPSTREAM/$MAIN ($(git rev-parse --short HEAD))"
else
  if ! git merge-base --is-ancestor "$LOCAL_MAIN_SHA" "$UPSTREAM_MAIN_SHA"; then
    die "local '$MAIN' has commits not in '$UPSTREAM/$MAIN' — refusing to overwrite.
       Inspect with: git log $UPSTREAM/$MAIN..$MAIN"
  fi
  ahead="$(git rev-list --count "$LOCAL_MAIN_SHA..$UPSTREAM_MAIN_SHA")"
  git merge --ff-only --quiet "$UPSTREAM/$MAIN"
  ok "$MAIN fast-forwarded by $ahead commit(s) → $(git rev-parse --short HEAD)"
fi

# ─── 4. Mirror to origin/main ─────────────────────────────────────────────
say "Mirror to $ORIGIN/$MAIN"
ORIGIN_MAIN_SHA="$(git rev-parse "$ORIGIN/$MAIN" 2>/dev/null || echo "")"
NEW_MAIN_SHA="$(git rev-parse "$MAIN")"
if [ "$ORIGIN_MAIN_SHA" = "$NEW_MAIN_SHA" ]; then
  ok "$ORIGIN/$MAIN already up to date"
else
  git push --quiet "$ORIGIN" "$MAIN"
  ok "pushed $MAIN to $ORIGIN"
fi

# ─── 5. Rebase personal on main ───────────────────────────────────────────
say "Rebase $PERSONAL on $MAIN"
git checkout --quiet "$PERSONAL"

PERSONAL_BEFORE="$(git rev-parse "$PERSONAL")"
PERSONAL_COMMITS_BEFORE="$(git rev-list --count "$MAIN..$PERSONAL")"

if git merge-base --is-ancestor "$MAIN" "$PERSONAL"; then
  ok "$PERSONAL already contains all of $MAIN — no rebase needed"
else
  BACKUP_REF="refs/heads/${PERSONAL}-pre-rebase-$(date +%Y%m%d-%H%M%S)"
  git update-ref "$BACKUP_REF" "$PERSONAL_BEFORE"
  ok "backup ref saved: $(echo "$BACKUP_REF" | sed 's|refs/heads/||')"

  set +e
  git rebase "$MAIN"
  REBASE_RC=$?
  set -e

  if [ "$REBASE_RC" -ne 0 ]; then
    err "rebase of '$PERSONAL' on '$MAIN' failed (conflicts)."
    err "  resolve, then:  git rebase --continue"
    err "  to bail:        git rebase --abort"
    err "  to restore:     git reset --hard $(echo "$BACKUP_REF" | sed 's|refs/heads/||')"
    exit "$REBASE_RC"
  fi
  PERSONAL_COMMITS_AFTER="$(git rev-list --count "$MAIN..$PERSONAL")"
  ok "$PERSONAL rebased on $MAIN ($PERSONAL_COMMITS_BEFORE → $PERSONAL_COMMITS_AFTER commits ahead of $MAIN)"
fi

# ─── 6. Push personal to origin (force-with-lease) ────────────────────────
say "Push $PERSONAL to $ORIGIN"
ORIGIN_PERSONAL_SHA="$(git rev-parse "$ORIGIN/$PERSONAL" 2>/dev/null || echo "")"
LOCAL_PERSONAL_SHA="$(git rev-parse "$PERSONAL")"
if [ "$ORIGIN_PERSONAL_SHA" = "$LOCAL_PERSONAL_SHA" ]; then
  ok "$ORIGIN/$PERSONAL already up to date"
else
  git push --quiet --force-with-lease "$ORIGIN" "$PERSONAL"
  ok "pushed $PERSONAL to $ORIGIN (--force-with-lease)"
fi

# ─── 7. Check other feature branches for staleness ────────────────────────
say "Check other branches"
STALE=()
while IFS= read -r b; do
  [ -z "$b" ] && continue
  [ "$b" = "$MAIN" ] && continue
  [ "$b" = "$PERSONAL" ] && continue
  case "$b" in "${PERSONAL}-pre-rebase-"*) continue ;; esac
  if ! git merge-base --is-ancestor "$MAIN" "$b"; then
    STALE+=("$b")
  fi
done < <(git for-each-ref --format='%(refname:short)' refs/heads/)

if [ "${#STALE[@]}" -eq 0 ]; then
  ok "no stale local branches"
else
  warn "local branches behind $MAIN — consider rebasing them next:"
  for b in "${STALE[@]}"; do
    behind="$(git rev-list --count "$b..$MAIN")"
    printf '    %s%s%s (%s commits behind %s)\n' "$YELLOW" "$b" "$NC" "$behind" "$MAIN" >&2
  done
fi

# ─── 8. Lockfile-changed hint ─────────────────────────────────────────────
LOCKFILE_AFTER_SHA="$(git hash-object package-lock.json 2>/dev/null || echo none)"
if [ "$LOCKFILE_BEFORE_SHA" != "$LOCKFILE_AFTER_SHA" ]; then
  warn "package-lock.json changed during sync — run 'npm ci' before the next build."
fi

say "Done"
ok "sync-upstream complete"
