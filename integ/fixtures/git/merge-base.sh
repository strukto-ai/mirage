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
parent=$(commit skew-parent 1000000000 -p "$ancestor")
child=$(commit skew-child 1000000001 -p "$parent")
commit skew-left 1000000200 -p "$ancestor" -p "$child" >/dev/null
commit skew-right 1000000300 -p "$ancestor" -p "$child" >/dev/null
git tag -a tagged -m tag x
# Two bases the walk meets oldest first: listed newest first anyway.
early=$(commit order-root 1000000500)
newer=$(commit order-newer 1000000560 -p "$early")
older=$(commit order-older 1000000530 -p "$early")
commit order-left 1000000600 -p "$newer" -p "$older" >/dev/null
near=$(commit order-near 1000000585 -p "$older")
far=$(commit order-far 1000000505 -p "$newer")
commit order-right 1000000590 -p "$near" -p "$far" >/dev/null
# Two bases of one date: listed in the order the walk meets them.
early=$(commit tie-root 1000000700)
first=$(commit tie-first 1000000730 -p "$early")
second=$(commit tie-second 1000000730 -p "$early")
commit tie-left 1000000800 -p "$first" -p "$second" >/dev/null
near=$(commit tie-near 1000000785 -p "$second")
far=$(commit tie-far 1000000705 -p "$first")
commit tie-right 1000000790 -p "$near" -p "$far" >/dev/null
hidden=$(commit shallow-hidden 1000000400)
boundary=$(commit shallow-boundary 1000000401 -p "$hidden")
other=$(commit shallow-other 1000000402 -p "$hidden")
a=$(commit shallow-a 1000000403 -p "$boundary")
b=$(commit shallow-b 1000000404 -p "$boundary")
commit shallow-left 1000000405 -p "$a" -p "$b" >/dev/null
commit shallow-right 1000000406 -p "$b" -p "$a" >/dev/null
printf '%s\n' "$boundary" "$other" > .git/shallow
git update-ref -d refs/heads/shallow-hidden
rm ".git/objects/${hidden:0:2}/${hidden:2}"
