#!/usr/bin/env bash
# Build the git fixture repository into $1.
#
# Generated rather than committed, because a repository cannot hold
# another repository's .git: `git add` silently refuses any path with a
# .git component, so a checked-in tree would look staged and never be.
# Generating also buys two things a checked-in tree could not: the
# fixture is readable as a script instead of as zlib blobs, and the same
# repository can be handed to the real git binary to produce the truth
# a case is compared against.
#
# Every identity and timestamp is pinned, so the object ids are the same
# on every machine and every run and a case can name a commit directly.
# Verify with: build.sh a && build.sh b && diff <(git -C a log) <(git -C b log)
set -euo pipefail

DEST="${1:?destination directory}"

export GIT_AUTHOR_NAME="Integ Author"
export GIT_AUTHOR_EMAIL="integ@example.com"
export GIT_COMMITTER_NAME="Integ Author"
export GIT_COMMITTER_EMAIL="integ@example.com"

mkdir -p "$DEST"
# -b main: the default branch name is a per-machine config, and a
# fixture whose branch depends on the host is not a fixture.
git -C "$DEST" init -q -b main

# The exports above only reach this script's own commits. Record the same
# identity in the repository so a caller that commits into the fixture
# afterwards works on a machine with no global identity, which is every CI
# runner: git refuses with "Author identity unknown" and exits 128.
git -C "$DEST" config user.name "$GIT_AUTHOR_NAME"
git -C "$DEST" config user.email "$GIT_AUTHOR_EMAIL"

commit() {
  local when="$1" message="$2"
  GIT_AUTHOR_DATE="$when" GIT_COMMITTER_DATE="$when" \
    git -C "$DEST" commit -q -m "$message"
}

printf 'alpha\nbeta\ngamma\n' > "$DEST/letters.txt"
printf 'one\n' > "$DEST/numbers.txt"
git -C "$DEST" add -A
commit "2026-01-05T10:00:00+0000" "first commit"

printf 'alpha\nbeta\ngamma\ndelta\n' > "$DEST/letters.txt"
git -C "$DEST" add -A
commit "2026-01-06T11:30:00+0000" "add delta"

mkdir -p "$DEST/docs"
printf 'notes\n' > "$DEST/docs/readme.md"
git -C "$DEST" add -A
commit "2026-01-07T09:15:00+0000" "add docs"

# Pack what exists so far, then commit once more. The fixture then holds
# both halves of an object database and exercises both read paths: the
# packfile window and a loose object fetched by id.
git -C "$DEST" repack -adq
printf 'one\ntwo\n' > "$DEST/numbers.txt"
git -C "$DEST" add -A
commit "2026-01-08T14:45:00+0000" "add two"

git -C "$DEST" branch -q topic HEAD~1
