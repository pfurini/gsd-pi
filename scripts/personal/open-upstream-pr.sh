#!/usr/bin/env bash
# scripts/personal/open-upstream-pr.sh
#
# Personal-only. Lives on the `personal` branch — must never reach an upstream PR.
#
# Open a clean PR to the upstream repo from the current feat/* (fix/*, etc.)
# branch. Runs every guardrail from CONTRIBUTING.md before pushing or hitting
# the GitHub API:
#
#   1. branch is a typed branch (feat/, fix/, refactor/, test/, docs/, chore/, ci/, perf/, build/, revert/)
#   2. branch is not `main` or `personal`
#   3. working tree is clean, no in-progress git ops
#   4. branch has at least 1 commit beyond upstream/main
#   5. branch is rebased on upstream/main (offers to rebase if behind)
#   6. every commit subject matches Conventional Commits
#   7. secret-scan passes against the PR diff
#   8. `npm run verify:pr` succeeds (build:core + typecheck:extensions + test:unit)
#   9. `gh` CLI is installed and authenticated
#  10. push to origin with --force-with-lease (only if previously pushed)
#  11. prompt for PR title (default = top-commit subject) and body (in $EDITOR)
#  12. open the PR via gh, print URL, optionally open in browser
#
# Usage: scripts/personal/open-upstream-pr.sh [--skip-verify]
#        --skip-verify   skip `npm run verify:pr` (rare — use only if you JUST ran it)

set -euo pipefail

UPSTREAM_REPO="${UPSTREAM_REPO:-gsd-build/gsd-2}"
UPSTREAM="${UPSTREAM_REMOTE:-upstream}"
ORIGIN="${ORIGIN_REMOTE:-origin}"
MAIN="${MAIN_BRANCH:-main}"

SKIP_VERIFY=0
for arg in "$@"; do
  case "$arg" in
    --skip-verify) SKIP_VERIFY=1 ;;
    -h|--help)
      sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) printf 'Unknown arg: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

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
ask()  { printf '%s? %s%s ' "$CYAN" "$*" "$NC" >&2; }

# ─── Move to repo root ────────────────────────────────────────────────────
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

CURRENT="$(git rev-parse --abbrev-ref HEAD)"

# ─── 1. Branch sanity ─────────────────────────────────────────────────────
say "Branch sanity"
case "$CURRENT" in
  feat/*|fix/*|refactor/*|test/*|docs/*|chore/*|ci/*|perf/*|build/*|revert/*)
    ok "branch '$CURRENT' uses a valid type prefix"
    ;;
  main|personal)
    die "refusing to open PR from '$CURRENT'. Create a feat/* branch off main first."
    ;;
  *)
    die "branch '$CURRENT' doesn't follow CONTRIBUTING.md naming. Rename with: git branch -m feat/<thing>"
    ;;
esac

# ─── 2. Working tree clean ───────────────────────────────────────────────
if ! git diff-index --quiet HEAD --; then
  die "working tree has uncommitted changes. Commit or stash them first."
fi
for inprogress in MERGE_HEAD REBASE_HEAD CHERRY_PICK_HEAD REVERT_HEAD; do
  if [ -e ".git/$inprogress" ]; then
    die "in-progress git operation detected (.git/$inprogress). Finish or abort it first."
  fi
done
ok "working tree clean"

# ─── 3. Remote + gh CLI ──────────────────────────────────────────────────
say "Tooling"
command -v gh >/dev/null 2>&1 \
  || die "gh CLI not installed. brew install gh, then 'gh auth login'"
gh auth status >/dev/null 2>&1 \
  || die "gh CLI not authenticated. Run: gh auth login"
ok "gh CLI ready"

git remote get-url "$UPSTREAM" >/dev/null 2>&1 \
  || die "remote '$UPSTREAM' not configured. Run: git remote add $UPSTREAM https://github.com/$UPSTREAM_REPO.git"
git remote get-url "$ORIGIN"   >/dev/null 2>&1 \
  || die "remote '$ORIGIN' not configured."
ok "remotes present ($UPSTREAM, $ORIGIN)"

# ─── 4. Branch is rebased on upstream/main ────────────────────────────────
say "Sync $UPSTREAM/$MAIN"
git fetch --quiet "$UPSTREAM" "$MAIN"

UPSTREAM_MAIN_SHA="$(git rev-parse "$UPSTREAM/$MAIN")"
COMMITS_AHEAD="$(git rev-list --count "$UPSTREAM/$MAIN..$CURRENT")"
COMMITS_BEHIND="$(git rev-list --count "$CURRENT..$UPSTREAM/$MAIN")"

if [ "$COMMITS_AHEAD" -eq 0 ]; then
  die "branch '$CURRENT' has no commits beyond $UPSTREAM/$MAIN. Nothing to PR."
fi
ok "$COMMITS_AHEAD commit(s) to PR"

if [ "$COMMITS_BEHIND" -gt 0 ]; then
  warn "branch is $COMMITS_BEHIND commit(s) behind $UPSTREAM/$MAIN."
  ask "Rebase on $UPSTREAM/$MAIN now? [y/N]:"
  read -r REPLY < /dev/tty || REPLY=""
  if [ "$REPLY" = "y" ] || [ "$REPLY" = "Y" ]; then
    BACKUP_REF="refs/heads/${CURRENT}-pre-rebase-$(date +%Y%m%d-%H%M%S)"
    git update-ref "$BACKUP_REF" "$(git rev-parse "$CURRENT")"
    ok "backup ref saved: $(echo "$BACKUP_REF" | sed 's|refs/heads/||')"
    if ! git rebase "$UPSTREAM/$MAIN"; then
      err "rebase failed. Resolve conflicts, then re-run this script."
      err "  to restore: git reset --hard $(echo "$BACKUP_REF" | sed 's|refs/heads/||')"
      exit 1
    fi
    ok "rebased on $UPSTREAM/$MAIN"
  else
    die "aborting. Rebase manually then re-run."
  fi
else
  ok "branch is up to date with $UPSTREAM/$MAIN"
fi

# ─── 5. Conventional Commits check ────────────────────────────────────────
say "Validate commit subjects"
CC_RE='^(feat|fix|docs|chore|refactor|test|infra|ci|perf|build|revert)(\([^)]+\))?!?: .+'
INVALID=()
while IFS= read -r line; do
  [ -z "$line" ] && continue
  sha="${line%% *}"
  subj="${line#* }"
  if ! printf '%s' "$subj" | grep -Eq "$CC_RE"; then
    INVALID+=("$sha $subj")
  fi
done < <(git log --oneline --no-merges "$UPSTREAM/$MAIN..$CURRENT")

if [ "${#INVALID[@]}" -gt 0 ]; then
  err "commits not following Conventional Commits:"
  for c in "${INVALID[@]}"; do printf '    %s\n' "$c" >&2; done
  err "fix with: git rebase -i $UPSTREAM/$MAIN"
  exit 1
fi
ok "all $COMMITS_AHEAD commit subject(s) follow Conventional Commits"

# ─── 6. Secret scan ──────────────────────────────────────────────────────
say "Secret scan"
if [ -f scripts/secret-scan.mjs ]; then
  if ! node scripts/secret-scan.mjs --diff "$UPSTREAM/$MAIN" >/dev/null 2>&1; then
    err "secret-scan found something — re-run for detail:"
    err "  node scripts/secret-scan.mjs --diff $UPSTREAM/$MAIN"
    exit 1
  fi
  ok "no secrets detected"
else
  warn "scripts/secret-scan.mjs not found — skipping"
fi

# ─── 7. verify:pr ─────────────────────────────────────────────────────────
if [ "$SKIP_VERIFY" -eq 1 ]; then
  warn "skipping 'npm run verify:pr' (--skip-verify)"
else
  say "Run npm run verify:pr (build + typecheck + tests)"
  warn "this can take a few minutes…"
  if ! npm run --silent verify:pr >/tmp/verify-pr.$$.log 2>&1; then
    err "verify:pr failed. Tail of log:"
    tail -40 "/tmp/verify-pr.$$.log" >&2
    err "full log at /tmp/verify-pr.$$.log"
    exit 1
  fi
  rm -f "/tmp/verify-pr.$$.log"
  ok "verify:pr passed"
fi

# ─── 8. Push to origin ────────────────────────────────────────────────────
say "Push $CURRENT to $ORIGIN"
ORIGIN_BRANCH_SHA="$(git rev-parse "$ORIGIN/$CURRENT" 2>/dev/null || echo "")"
LOCAL_BRANCH_SHA="$(git rev-parse "$CURRENT")"
if [ "$ORIGIN_BRANCH_SHA" = "$LOCAL_BRANCH_SHA" ]; then
  ok "$ORIGIN/$CURRENT already up to date"
elif [ -z "$ORIGIN_BRANCH_SHA" ]; then
  git push --quiet -u "$ORIGIN" "$CURRENT"
  ok "first push of $CURRENT to $ORIGIN"
else
  git push --quiet --force-with-lease "$ORIGIN" "$CURRENT"
  ok "$CURRENT updated on $ORIGIN (--force-with-lease)"
fi

# ─── 9. PR title + body ───────────────────────────────────────────────────
say "Compose PR"

PR_TITLE_DEFAULT="$(git log -1 --pretty='%s' "$CURRENT")"

PR_BODY_FILE="$(mktemp -t gsd-pr-body.XXXXXX)"
{
  printf '## Summary\n\n'
  while IFS= read -r commit_sha; do
    subj="$(git log -1 --pretty='%s' "$commit_sha")"
    body="$(git log -1 --pretty='%b' "$commit_sha")"
    printf -- '- %s\n' "$subj"
    if [ -n "$body" ]; then
      printf '%s\n' "$body" | sed 's/^/  /'
    fi
  done < <(git rev-list --reverse --no-merges "$UPSTREAM/$MAIN..$CURRENT")
  printf '\n## Test plan\n\n- [x] verify:pr passes locally\n- [ ] \n\n'
  printf '<!-- Lines starting with # are dropped. Leave the file empty to abort. -->\n'
} > "$PR_BODY_FILE"

ask "PR title [${DIM}${PR_TITLE_DEFAULT}${NC}]:"
read -r PR_TITLE < /dev/tty || PR_TITLE=""
PR_TITLE="${PR_TITLE:-$PR_TITLE_DEFAULT}"

warn "opening \$EDITOR (${EDITOR:-vi}) to edit PR body — save+exit to continue, empty file to abort"
"${EDITOR:-vi}" "$PR_BODY_FILE"

# Strip comment lines (#) from body, then check it's non-empty
PR_BODY="$(grep -v '^#' "$PR_BODY_FILE" || true)"
rm -f "$PR_BODY_FILE"

if [ -z "$(printf '%s' "$PR_BODY" | tr -d '[:space:]')" ]; then
  die "PR body is empty — aborting before hitting GitHub."
fi

# ─── 10. Create the PR ────────────────────────────────────────────────────
say "Create PR on $UPSTREAM_REPO"

GH_USER="$(gh api user --jq .login)"

# Look for an existing open PR first so we don't double-up
EXISTING="$(gh pr list \
  --repo "$UPSTREAM_REPO" \
  --head "$GH_USER:$CURRENT" \
  --state open \
  --json url \
  --jq '.[0].url // empty' 2>/dev/null || echo "")"

if [ -n "$EXISTING" ]; then
  warn "an open PR already exists for $GH_USER:$CURRENT → $EXISTING"
  ok "the latest commits were pushed, so the existing PR is now up to date"
  PR_URL="$EXISTING"
else
  PR_URL="$(gh pr create \
    --repo "$UPSTREAM_REPO" \
    --base "$MAIN" \
    --head "$GH_USER:$CURRENT" \
    --title "$PR_TITLE" \
    --body "$PR_BODY")"
  ok "PR created"
fi

printf '\n%sPR:%s %s\n\n' "$GREEN" "$NC" "$PR_URL" >&2

ask "Open in browser? [y/N]:"
read -r REPLY < /dev/tty || REPLY=""
if [ "$REPLY" = "y" ] || [ "$REPLY" = "Y" ]; then
  gh pr view "$PR_URL" --web >/dev/null 2>&1 || true
fi

ok "done"
