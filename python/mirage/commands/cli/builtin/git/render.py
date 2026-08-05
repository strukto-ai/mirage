# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

from mirage.commands.cli.builtin.git.types import StatusEntry

UNCHANGED = " "
UNTRACKED = "?"
UNMERGED_COLUMN = "U"

# Width of the label column, which git fixes per section rather than
# measuring: wide enough for the longest label the section can print
# ("typechange:" among the changes, "deleted by them:" among the
# conflicts).
LABEL_WIDTH = 12
CONFLICT_WIDTH = 17

STAGED_LABELS = {
    "M": "modified:",
    "A": "new file:",
    "D": "deleted:",
    "R": "renamed:",
    "C": "copied:",
    "T": "typechange:",
}

WORK_LABELS = {
    "M": "modified:",
    "D": "deleted:",
    "T": "typechange:",
}

CONFLICT_LABELS = {
    "DD": "both deleted:",
    "AU": "added by us:",
    "UD": "deleted by them:",
    "UA": "added by them:",
    "DU": "deleted by us:",
    "AA": "both added:",
    "UU": "both modified:",
}

# Every escape git spells with a letter rather than an octal triple.
ESCAPES = {
    0x07: "\\a",
    0x08: "\\b",
    0x0C: "\\f",
    0x0A: "\\n",
    0x0D: "\\r",
    0x09: "\\t",
    0x0B: "\\v",
    0x22: '\\"',
    0x5C: "\\\\",
}

ON_BRANCH = "On branch "
DETACHED = "HEAD detached at "
NO_COMMITS = "No commits yet"
BRANCH_MARK = "## "
NO_COMMITS_BRANCH = "No commits yet on "

STAGED_HEADER = "Changes to be committed:"
UNMERGED_HEADER = "Unmerged paths:"
WORK_HEADER = "Changes not staged for commit:"
UNTRACKED_HEADER = "Untracked files:"

UNSTAGE_HINT = '  (use "git restore --staged <file>..." to unstage)'
UNCACHE_HINT = '  (use "git rm --cached <file>..." to unstage)'
RESOLVE_HINT = '  (use "git add <file>..." to mark resolution)'
# git widens the first hint to name `rm` as soon as the section holds a
# deletion, because `git add` alone does stage one but reads as the wrong
# advice for a file that is gone.
WORK_HINT = '  (use "git add <file>..." to update what will be committed)'
WORK_HINT_DELETED = ('  (use "git add/rm <file>..." to update what will be '
                     'committed)')
DISCARD_HINT = ('  (use "git restore <file>..." to discard changes in '
                'working directory)')
UNTRACKED_HINT = ('  (use "git add <file>..." to include in what will be '
                  'committed)')

CONFLICT_HEADER = ("You have unmerged paths.",
                   '  (fix conflicts and run "git commit")',
                   '  (use "git merge --abort" to abort the merge)')
RESOLVED_HEADER = ("All conflicts fixed but you are still merging.",
                   '  (use "git commit" to conclude merge)')

CLEAN = "nothing to commit, working tree clean"
CLEAN_INITIAL = 'nothing to commit (create/copy files and use "git add" to '\
                'track)'
UNSTAGED_ONLY = 'no changes added to commit (use "git add" and/or "git '\
                'commit -a")'
UNTRACKED_ONLY = 'nothing added to commit but untracked files present (use '\
                 '"git add" to track)'
# The two things `-uno` says instead, and they are not the same line:
# with something staged git notes what it skipped, and with nothing at
# all it says the tree is empty of changes but stops short of calling it
# clean, since it did not look.
UNTRACKED_HIDDEN = "Untracked files not listed (use -u option to show "\
                   "untracked files)"
CLEAN_UNSCANNED = "nothing to commit (use -u to show untracked files)"


def quote_path(path: str, porcelain: bool) -> str:
    """Spell a path the way git spells it, quoting only when it must.

    git C-quotes a path holding anything that would not survive being
    read back: a quote, a backslash, a control character, or a byte
    outside ASCII. The machine-readable formats also quote a path
    holding a space, and the human-readable one does not, which is not
    an inconsistency: only the former is parsed by splitting on
    whitespace. Verified both ways against git 2.47.

    Args:
        path (str): repository-relative path.
        porcelain (bool): whether a space alone forces quoting.
    """
    raw = path.encode("utf-8", errors="surrogateescape")
    special = any(byte in ESCAPES or byte < 0x20 or byte >= 0x7F
                  for byte in raw)
    if not special and not (porcelain and b" " in raw):
        return path
    if not special:
        return f'"{path}"'
    out = []
    for byte in raw:
        escape = ESCAPES.get(byte)
        if escape is not None:
            out.append(escape)
        elif byte < 0x20 or byte >= 0x7F:
            out.append(f"\\{byte:03o}")
        else:
            out.append(chr(byte))
    body = "".join(out)
    return f'"{body}"'


def short_line(entry: StatusEntry) -> str:
    """One row of ``--short`` / ``--porcelain`` output.

    Args:
        entry (StatusEntry): the row.
    """
    path = quote_path(entry.path, True)
    if entry.original is not None:
        path = f"{quote_path(entry.original, True)} -> {path}"
    return f"{entry.index_status}{entry.tree_status} {path}"


def branch_line(branch: str | None, commit: str | None,
                no_commits: bool) -> str:
    """The ``## `` header ``--branch`` prepends to the short formats.

    Args:
        branch (str | None): the branch HEAD names, None when detached.
        commit (str | None): the abbreviated commit HEAD holds, set only
            when detached.
        no_commits (bool): whether HEAD resolves to nothing yet.
    """
    if branch is None:
        return f"{BRANCH_MARK}HEAD (no branch)"
    if no_commits:
        return f"{BRANCH_MARK}{NO_COMMITS_BRANCH}{branch}"
    return f"{BRANCH_MARK}{branch}"


def short_format(rows: list[StatusEntry], header: str | None) -> str:
    """The whole of ``--short`` / ``--porcelain`` output.

    Args:
        rows (list[StatusEntry]): every row, already in git's order.
        header (str | None): the ``## `` line, or None without
            ``--branch``.
    """
    lines = [] if header is None else [header]
    lines.extend(short_line(row) for row in rows)
    return "".join(f"{line}\n" for line in lines)


def _section(header: str, hints: tuple[str, ...],
             entries: list[str]) -> list[str]:
    """One block of the long format, or nothing when it has no entries.

    Args:
        header (str): the section's own line.
        hints (tuple[str, ...]): the parenthesised advice under it.
        entries (list[str]): already-rendered entry lines.
    """
    if not entries:
        return []
    return [header, *hints, *entries, ""]


def _labelled(label: str, path: str, width: int) -> str:
    """One entry line: a tab, a padded label, then the path.

    Args:
        label (str): the label including its colon.
        path (str): the path as it should read.
        width (int): the column the path starts at.
    """
    return f"\t{label:<{width}}{path}"


def _staged_entries(rows: list[StatusEntry]) -> list[str]:
    """The entry lines of the "Changes to be committed" section.

    Args:
        rows (list[StatusEntry]): every row.
    """
    lines = []
    for row in rows:
        if row.index_status in (UNCHANGED, UNTRACKED, UNMERGED_COLUMN):
            continue
        label = STAGED_LABELS.get(row.index_status, "modified:")
        path = quote_path(row.path, False)
        if row.original is not None:
            path = f"{quote_path(row.original, False)} -> {path}"
        lines.append(_labelled(label, path, LABEL_WIDTH))
    return lines


def _work_entries(rows: list[StatusEntry]) -> list[str]:
    """The entry lines of the "Changes not staged for commit" section.

    Args:
        rows (list[StatusEntry]): every row.
    """
    lines = []
    for row in rows:
        if row.index_status == UNMERGED_COLUMN or row.tree_status in (
                UNCHANGED, UNTRACKED):
            continue
        label = WORK_LABELS.get(row.tree_status, "modified:")
        lines.append(_labelled(label, quote_path(row.path, False),
                               LABEL_WIDTH))
    return lines


def _unmerged_entries(rows: list[StatusEntry]) -> list[str]:
    """The entry lines of the "Unmerged paths" section.

    Args:
        rows (list[StatusEntry]): every row.
    """
    lines = []
    for row in rows:
        code = f"{row.index_status}{row.tree_status}"
        if code not in CONFLICT_LABELS:
            continue
        lines.append(
            _labelled(CONFLICT_LABELS[code], quote_path(row.path, False),
                      CONFLICT_WIDTH))
    return lines


def _untracked_entries(rows: list[StatusEntry]) -> list[str]:
    """The entry lines of the "Untracked files" section.

    Args:
        rows (list[StatusEntry]): every row.
    """
    return [
        f"\t{quote_path(row.path, False)}" for row in rows
        if row.index_status == UNTRACKED
    ]


def _trailer(staged: list[str], work: list[str], unmerged: list[str],
             untracked: list[str], no_commits: bool,
             hide_untracked: bool) -> list[str]:
    """git's closing line, which says what the sections above did not.

    Exactly one line, or none: the line exists to explain why
    ``git commit`` would refuse, so with something already staged there
    is nothing to explain and git says nothing. ``-uno`` does not add a
    line, it substitutes the two that mention untracked files, which is
    why it is threaded through here rather than appended by the caller.

    Args:
        staged (list[str]): rendered staged entries.
        work (list[str]): rendered unstaged entries.
        unmerged (list[str]): rendered unmerged entries.
        untracked (list[str]): rendered untracked entries.
        no_commits (bool): whether HEAD resolves to nothing yet.
        hide_untracked (bool): whether ``-uno`` suppressed the scan.
    """
    if staged:
        return [UNTRACKED_HIDDEN] if hide_untracked else []
    if work or unmerged:
        return [UNSTAGED_ONLY]
    if untracked:
        return [UNTRACKED_ONLY]
    if no_commits:
        return [CLEAN_INITIAL]
    return [CLEAN_UNSCANNED if hide_untracked else CLEAN]


def long_format(rows: list[StatusEntry], branch: str | None,
                commit: str | None, no_commits: bool, merging: bool,
                hide_untracked: bool) -> str:
    """The default, human-readable status report.

    Args:
        rows (list[StatusEntry]): every row, already in git's order.
        branch (str | None): the branch HEAD names, None when detached.
        commit (str | None): the abbreviated commit HEAD holds, set only
            when detached.
        no_commits (bool): whether HEAD resolves to nothing yet.
        merging (bool): whether a merge is in progress.
        hide_untracked (bool): whether ``-uno`` suppressed the scan.
    """
    staged = _staged_entries(rows)
    unmerged = _unmerged_entries(rows)
    work = _work_entries(rows)
    untracked = _untracked_entries(rows)
    lines = [
        f"{ON_BRANCH}{branch}"
        if branch is not None else f"{DETACHED}{commit or ''}"
    ]
    if no_commits:
        lines.extend(["", NO_COMMITS, ""])
    if merging:
        lines.extend(CONFLICT_HEADER if unmerged else RESOLVED_HEADER)
        lines.append("")
    # A merge in progress removes the unstage hint, because unstaging is
    # not what resolving a conflict means and git stops offering it.
    if merging:
        staged_hints: tuple[str, ...] = ()
    else:
        staged_hints = (UNCACHE_HINT if no_commits else UNSTAGE_HINT, )
    lines.extend(_section(STAGED_HEADER, staged_hints, staged))
    lines.extend(_section(UNMERGED_HEADER, (RESOLVE_HINT, ), unmerged))
    # Read off the rendered lines rather than the rows, so the hint can
    # only ever describe entries this section actually prints: an
    # unmerged path can also carry a D and is reported elsewhere.
    deleted = any(line.startswith(f"\t{WORK_LABELS['D']}") for line in work)
    lines.extend(
        _section(WORK_HEADER,
                 (WORK_HINT_DELETED if deleted else WORK_HINT, DISCARD_HINT),
                 work))
    lines.extend(_section(UNTRACKED_HEADER, (UNTRACKED_HINT, ), untracked))
    lines.extend(
        _trailer(staged, work, unmerged, untracked, no_commits,
                 hide_untracked))
    return "".join(f"{line}\n" for line in lines)
