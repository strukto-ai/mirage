#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$1"
cd "$1"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=A GIT_AUTHOR_EMAIL=a@example.com
export GIT_COMMITTER_NAME=A GIT_COMMITTER_EMAIL=a@example.com
export GIT_AUTHOR_DATE=2024-01-01T00:00:00Z GIT_COMMITTER_DATE=2024-01-01T00:00:00Z
git init -q -b main src
cd src
printf 'one\n' > a
mkdir docs
printf 'notes\n' > docs/readme.md
git add -A
git commit -qm first
git tag v1
git tag -a -m annotated v1a
printf 'two\n' > a
git commit -qam second
git branch topic HEAD~1
cd ..
git init -q --bare empty.git
git init -q -b main odd
cd odd
printf 'a\n' > a
git add a
git commit -qm first
hex() { printf '%s' "$1" | sed 's/../\\x&/g'; }
tree() { printf "$1" | git hash-object -t tree --literally -w --stdin; }
above=$(printf 'above\n' | git hash-object -w --stdin)
config=$(printf '[core]\n' | git hash-object -w --stdin)
fresh=$(printf 'fresh\n' | git hash-object -w --stdin)
up=$(tree "100644 above.txt\0$(hex "$above")")
dotgit=$(tree "100644 config\0$(hex "$config")")
sub=$(tree "40000 .git\0$(hex "$dotgit")")
top=$(tree "40000 ..\0$(hex "$up")100644 a\0$(hex "$(git rev-parse HEAD:a)")100644 fresh\0$(hex "$fresh")40000 sub\0$(hex "$sub")")
git branch bad "$(git commit-tree -p HEAD -m bad "$top")"
target=$(printf 'x' | git hash-object -w --stdin)
ntfs=$(tree "100644 a\0$(hex "$(git rev-parse HEAD:a)")40000 git~1\0$(hex "$dotgit")")
link=$(tree "120000 .gitmodules\0$(hex "$target")40000 sub\0$(hex "$ntfs")")
git branch ntfs "$(git commit-tree -p HEAD -m ntfs "$link")"
cd ..
