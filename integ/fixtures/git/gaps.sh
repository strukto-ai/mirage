#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$1"
cd "$1"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=Alice GIT_AUTHOR_EMAIL=alice@example.com
export GIT_COMMITTER_NAME=Alice GIT_COMMITTER_EMAIL=alice@example.com
export GIT_AUTHOR_DATE=2024-01-01T00:00:00Z GIT_COMMITTER_DATE=2024-01-01T00:00:00Z
git init -q -b main
printf 'one\n' > README.md
printf 'int f(void)\n{\n\tint a = 1;\n\tint b = 2;\n\treturn a;\n}\n\nint g(void)\n{\n\treturn 3;\n}\n' > f.c
printf '*.log\ncache/\nempty/\n' > .gitignore
printf '%s\n' 'Alice Smith <alice@example.com>' 'Bobby <bob@example.com>' \
  'Robert <robert@example.org> Bob <bob@example.com>' \
  '<rob@example.org> Bob <bob@example.com>' > .mailmap
mkdir docs
printf 'nested\n' > docs/note.txt
for function in first middle last; do
  printf 'int %s(void)\n{\n' "$function"
  for n in $(seq 1 12); do printf '\tstep(%s);\n' "$n"; done
  printf '\treturn 1;\n}\n\n'
done > functions.c
git add -A
git commit -qm first
printf 'two\n' > README.md
sed 's/return a/return b/' f.c > tmp.c
mv tmp.c f.c
export GIT_AUTHOR_NAME=Bob GIT_AUTHOR_EMAIL=bob@example.com
export GIT_COMMITTER_NAME=Bob GIT_COMMITTER_EMAIL=bob@example.com
sed 's/return 1/return 2/' functions.c > tmp.c
mv tmp.c functions.c
git commit -qam second
git update-ref --create-reflog -m 'fetch: fast-forward' refs/remotes/origin/main HEAD~1
git tag v1 HEAD~1
git tag -a v2 -m 'release two'
git branch dup HEAD~1
git tag -a dup -m 'tagged dup'
git tag twin-a "$(printf '195\n' | git hash-object -w --stdin)"
git tag twin-b "$(printf '389\n' | git hash-object -w --stdin)"
printf 'ignored\n' > debug.log
mkdir cache empty
printf 'ignored\n' > cache/file
