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

from difflib import SequenceMatcher

from dulwich.object_store import BaseObjectStore
from dulwich.objects import Blob, Commit, ObjectID

from mirage.commands.cli.builtin.git.format import short

ROOT_COMMIT = "(root-commit) "
CREATE = "create"
DELETE = "delete"


def _lines(store: BaseObjectStore, sha: bytes | None) -> list[bytes]:
    """A blob's lines, empty when there is no blob on that side.

    Args:
        store (BaseObjectStore): the object database.
        sha (ObjectID | None): the blob id, None when the file is being
            created or removed.
    """
    if sha is None:
        return []
    obj = store[ObjectID(sha)]
    if not isinstance(obj, Blob):
        return []
    return obj.data.splitlines(keepends=True)


def count_changes(store: BaseObjectStore, before: dict[bytes, tuple[int,
                                                                    bytes]],
                  after: dict[bytes, tuple[int, bytes]]) -> tuple[int, int]:
    """How many lines a commit added and removed, over every path.

    Counted with the same longest-common-subsequence that ``diff`` uses,
    so the totals agree with what git prints. They are line counts, not
    hunk counts: a rewritten line is one insertion and one deletion.

    Args:
        store (BaseObjectStore): the object database.
        before (dict): the parent tree, path to (mode, blob id).
        after (dict): the new tree, path to (mode, blob id).
    """
    insertions = 0
    deletions = 0
    for path in set(before) | set(after):
        old = before.get(path)
        new = after.get(path)
        if old is not None and new is not None and old[1] == new[1]:
            continue
        old_lines = _lines(store, None if old is None else old[1])
        new_lines = _lines(store, None if new is None else new[1])
        matcher = SequenceMatcher(a=old_lines, b=new_lines, autojunk=False)
        for tag, i1, i2, j1, j2 in matcher.get_opcodes():
            if tag == "equal":
                continue
            deletions += i2 - i1
            insertions += j2 - j1
    return insertions, deletions


def _plural(count: int, noun: str) -> str:
    """``N noun`` with the noun pluralised the way git pluralises it.

    Args:
        count (int): how many.
        noun (str): the singular noun.
    """
    return f"{count} {noun}" if count == 1 else f"{count} {noun}s"


def stat_line(files: int, insertions: int, deletions: int) -> str:
    """git's one-line diffstat.

    A clause that would read zero is dropped, unless both would, in
    which case both are kept: a commit that changed a file without
    changing a line still has to say something about the lines, and
    " 1 file changed" alone reads like a truncation. Pinned against git
    2.47 by committing an empty file.

    Args:
        files (int): how many paths changed.
        insertions (int): lines added.
        deletions (int): lines removed.
    """
    parts = [f" {_plural(files, 'file')} changed"]
    if insertions or not deletions:
        parts.append(_plural(insertions, "insertion") + "(+)")
    if deletions or not insertions:
        parts.append(_plural(deletions, "deletion") + "(-)")
    return ", ".join(parts)


def mode_lines(before: dict[bytes, tuple[int, bytes]],
               after: dict[bytes, tuple[int, bytes]]) -> list[str]:
    """The ``create mode`` / ``delete mode`` lines, in git's order.

    Args:
        before (dict): the parent tree, path to (mode, blob id).
        after (dict): the new tree, path to (mode, blob id).
    """
    lines = []
    for path in sorted(set(after) - set(before)):
        mode = after[path][0]
        lines.append(f" {CREATE} mode {mode:06o} "
                     f"{path.decode('utf-8', errors='replace')}")
    for path in sorted(set(before) - set(after)):
        mode = before[path][0]
        lines.append(f" {DELETE} mode {mode:06o} "
                     f"{path.decode('utf-8', errors='replace')}")
    return lines


def report(store: BaseObjectStore, commit: Commit, branch: str | None,
           before: dict[bytes, tuple[int, bytes]],
           after: dict[bytes, tuple[int,
                                    bytes]], width: int, root: bool) -> bytes:
    """What ``git commit`` prints once the commit exists.

    Args:
        store (BaseObjectStore): the object database.
        commit (Commit): the commit just written.
        branch (str | None): the branch it landed on, None when
            detached.
        before (dict): the parent tree, path to (mode, blob id).
        after (dict): the new tree, path to (mode, blob id).
        width (int): how many hex digits to abbreviate the id to.
        root (bool): whether this is the repository's first commit.
    """
    changed = {
        path
        for path in set(before) | set(after)
        if before.get(path) != after.get(path)
    }
    title = commit.message.decode("utf-8", errors="replace").split("\n")[0]
    where = branch if branch is not None else "detached HEAD"
    marker = ROOT_COMMIT if root else ""
    lines = [f"[{where} {marker}{short(commit.id, width)}] {title}"]
    if changed:
        insertions, deletions = count_changes(store, before, after)
        lines.append(stat_line(len(changed), insertions, deletions))
    lines.extend(mode_lines(before, after))
    return "".join(f"{line}\n" for line in lines).encode()
