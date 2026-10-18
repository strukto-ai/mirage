#!/usr/bin/env bash
set -euo pipefail
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=Test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=Test GIT_COMMITTER_EMAIL=test@example.com
n=0
commit() {
  n=$((n + 1))
  GIT_AUTHOR_DATE="@$((1700000000 + n * 60)) +0000" \
    GIT_COMMITTER_DATE="@$((1700000000 + n * 60)) +0000" \
    git commit -q --allow-empty --allow-empty-message -m "$1"
}
git init -q -b main "$1-up"
cd "$1-up"
commit first
commit second
commit 'third subject'
git branch topic HEAD~1
git branch doomed HEAD~2
git clone -q "$1-up" "$1"
cd "$1"
git config maintenance.auto false
commit 'local ahead'
git branch -q --track behind origin/topic
git branch -q --track diverged origin/topic
git checkout -q diverged
commit diverge
git checkout -q main
git -C "$1-up" checkout -q topic
(cd "$1-up" && commit 'upstream moves')
git fetch -q
git branch -q --track level origin/main
git branch -q --track orphaned origin/doomed
git -C "$1-up" branch -q -D doomed
git fetch -q --prune
git branch -q a-much-longer-branch-name HEAD~2
git branch -q "$(printf 'w\303\244hrung')" HEAD~1
git branch -q "$(printf '\344\270\255\346\226\207')" HEAD~1
git branch -q local-upstream main
git config branch.local-upstream.remote .
git config branch.local-upstream.merge refs/heads/level
git symbolic-ref refs/heads/alias refs/heads/main
git checkout -q -b quiet main~1
commit ''
git checkout -q -b two-line main~1
commit "$(printf 'line one\nline two\n\nbody')"
git checkout -q main
git worktree add -q "$1-wt" -b elsewhere HEAD~1
