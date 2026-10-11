#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$1"
cd "$1"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=Test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=Test GIT_COMMITTER_EMAIL=test@example.com
git init -q -b main
tree=$(git mktree </dev/null)
commit() {
  local name="$1" time="$2"
  shift 2
  local oid
  oid=$(GIT_AUTHOR_DATE="@$time +0000" GIT_COMMITTER_DATE="@$time +0000" git commit-tree "$tree" -m "$name" "$@")
  git update-ref "refs/heads/$name" "$oid"
  printf '%s' "$oid"
}
root=$(commit root 1000000000)
a=$(commit a 1000000001 -p "$root")
b=$(commit b 1000000002 -p "$root")
commit x 1000000003 -p "$a" -p "$b" >/dev/null
commit y 1000000004 -p "$b" -p "$a" >/dev/null
commit isolated 1000000005 >/dev/null
ancestor=$(commit skew-root 1000000100)
child=$(commit skew-child 1000000001 -p "$ancestor")
commit skew-left 1000000200 -p "$ancestor" -p "$child" >/dev/null
commit skew-right 1000000300 -p "$ancestor" -p "$child" >/dev/null
git tag -a tagged -m tag x
