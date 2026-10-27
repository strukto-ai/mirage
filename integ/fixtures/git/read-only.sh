#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$1"
cd "$1"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=Ada GIT_AUTHOR_EMAIL=ada@example.com
export GIT_COMMITTER_NAME=Ada GIT_COMMITTER_EMAIL=ada@example.com
at() { export GIT_AUTHOR_DATE="$1" GIT_COMMITTER_DATE="${2:-$1}"; }
git init -q -b main
git config maintenance.auto false
git config gc.auto 0
git remote add origin https://example.com/demo.git
printf 'demo\n' > README.md
printf 'one\ntwo\nthree\n' > notes.txt
at 2024-06-01T10:00:00Z
git add -A
git commit -qm initial
printf 'demo\nmore\n' > README.md
at 2024-09-15T10:00:00Z
git commit -qam 'extend readme'
mkdir docs
git mv notes.txt docs/notes.md
at 2024-12-20T10:00:00Z
git commit -qm 'move notes'
git switch -qc side
printf 'feature\n' > feature.txt
printf 'demo\nmore from side\n' > README.md
at 2024-11-01T10:00:00Z 2025-02-10T10:00:00Z
git add -A
git commit -qm 'add feature'
git switch -q main
printf 'app\n' > app.txt
printf 'demo\nmore from main\n' > README.md
at 2025-03-01T10:00:00Z
git add -A
git commit -qm 'add app'
at 2025-04-01T10:00:00Z
if git merge -q side -m 'merge side' >/dev/null 2>&1; then
  echo 'expected a merge conflict' >&2
  exit 1
fi
printf 'demo\nmore from both\n' > README.md
git add README.md
git commit -qm 'merge side'
git switch -qc edited HEAD~2
git mv docs/notes.md docs/moved.md
printf 'four\n' >> docs/moved.md
printf '\000\001\002' > binary.dat
chmod +x README.md
at 2025-04-02T10:00:00Z
git add -A
git commit -qm 'rename with edits and binary addition'
body() {
  for i in $(seq 1 20); do
    case $i in
      5) echo 'function handleRequest(request, response) {' ;;
      15) echo "  $1" ;;
      *) echo "  body $i" ;;
    esac
  done
}
git switch -qc evil-base main
body 'body 15' > f.txt
seq 1 20 > n.txt
seq 1 20 > m.txt
seq 1 30 > h.txt
printf 'x\ny\nlast' > tail.txt
printf 'gone\n' > gone.txt
printf 'perm\n' > perm.txt
at 2025-05-01T10:00:00Z
git add -A
git commit -qm 'evil base'
git switch -qc evil-side
body SIDE > f.txt
seq 1 20 | sed -e 's/^2$/two/' > n.txt
seq 1 20 | sed -e 's/^2$/two/' > m.txt
seq 1 30 | sed -e 's/^12$/twelve/' > h.txt
printf 'x\ny\nSIDE' > tail.txt
at 2025-05-02T10:00:00Z
git commit -qam 'evil side'
git switch -qc evil evil-base
body MAIN > f.txt
seq 1 20 | sed -e 's/^8$/eight/' > n.txt
seq 1 20 | sed -e 's/^5$/five/' > m.txt
seq 1 30 | sed -e '/^9$/d' -e 's/^20$/twenty/' > h.txt
printf 'x\ny\nMAIN' > tail.txt
at 2025-05-03T10:00:00Z
git commit -qam 'evil main'
at 2025-05-04T10:00:00Z
if git merge -q evil-side -m 'evil merge' >/dev/null 2>&1; then
  echo 'expected a merge conflict' >&2
  exit 1
fi
body BOTH > f.txt
printf 'x\ny\nBOTH' > tail.txt
printf 'new\n' > new.txt
git rm -q gone.txt
chmod +x perm.txt
git add -A
git commit -qm 'evil merge'
git switch -q main
git switch -qc quoted main
printf 'one\ntwo\n' > é.txt
printf 'x\n' > "$(printf 'tab\there.txt')"
printf 'q\n' > 'quo"te.txt'
printf 's\n' > 'sp ace.txt'
printf 'link me\n' > kind.txt
mkdir -p dir
printf 'd\nd2\nd3\n' > dir/naïve.md
at 2025-06-01T10:00:00Z
git add -A
git commit -qm 'quoted base'
printf 'one\ntwo\nthree\n' > é.txt
git mv dir/naïve.md dir/ünïcode.md
git mv 'sp ace.txt' 'späce.txt'
chmod +x 'späce.txt'
rm kind.txt
ln -s é.txt kind.txt
at 2025-06-02T10:00:00Z
git add -A
git commit -qm 'quoted change'
git switch -q main
blob=$(printf 'odd\n' | git hash-object -w --stdin)
tree=$({ git ls-tree main; printf '100644 blob %s\t\377.txt\n' "$blob"; } | git mktree)
at 2025-05-05T10:00:00Z
git update-ref refs/heads/odd "$(git commit-tree "$tree" -p main -m 'odd name')"
git tag light side
at 2025-06-03T10:00:00Z
git tag -a annotated -m 'release two' main~1
# A hidden side whose path back to a shared commit runs through a commit
# dated before it: once the shown side is used up only hidden commits are
# queued, and the limited walk has to keep going past that point, or the
# shared commit leaks into the range. It has a parent, so no root sits
# above an unrelated commit in a graph, which git 2.56 draws apart; the
# ranges hide that parent, so only hidden commits are queued after it.
at 2025-07-01T10:00:00Z
shared=$(git commit-tree "$(git rev-parse main^{tree})" -p main -m 'skew shared')
at 2025-07-02T10:00:00Z
git update-ref refs/heads/skew-shown "$(git commit-tree "$(git rev-parse main^{tree})" -p "$shared" -m 'skew shown')"
at 2025-06-01T10:00:00Z
early=$(git commit-tree "$(git rev-parse main^{tree})" -p "$shared" -m 'skew early')
at 2025-07-03T10:00:00Z
git update-ref refs/heads/skew-hidden "$(git commit-tree "$(git rev-parse main^{tree})" -p "$early" -m 'skew hidden')"

at 2025-08-01T10:00:00Z
git switch -qc authors main
printf 'bob\n' > bob.txt
git add bob.txt
GIT_AUTHOR_NAME=Bob GIT_AUTHOR_EMAIL=bob@example.com git commit -qm 'by Bob'
# Messages for --grep and -i: a match only in the body, and the same
# word in two cases.
at 2025-08-02T10:00:00Z
git switch -qc messages main
printf 'cache\n' > cache.txt
git add cache.txt
git commit -qm 'Add caching layer' -m 'Guarded by remove_caching_layer.'
at 2025-08-03T10:00:00Z
printf 'flag\n' >> cache.txt
GIT_AUTHOR_NAME=Bob GIT_AUTHOR_EMAIL=bob@example.com git commit -qam 'fix: Remove_Caching_Layer flag'
at 2025-08-04T10:00:00Z
printf 'typo\n' >> cache.txt
git commit -qam 'docs: FIX typo'
# Non-ASCII case pairs must stay distinct under the fixed C locale.
at 2025-08-05T10:00:00Z
git switch -qc casefold main
printf 'ÉLAN Aa\n' > casefold.txt
git add casefold.txt
GIT_AUTHOR_NAME=Élodie git commit -qm 'ÉLAN Aa'
at 2025-08-06T10:00:00Z
printf 'élan aA\n' >> casefold.txt
GIT_AUTHOR_NAME=élodie git commit -qam 'élan aA'
git switch -q main
printf 'staged\n' > staged.txt
git add staged.txt
printf 'not staged\n' >> staged.txt
printf 'unstaged\n' >> README.md
