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

from dataclasses import dataclass
from difflib import SequenceMatcher

from dulwich.object_store import BaseObjectStore, iter_tree_contents
from dulwich.objects import Blob, Commit, ObjectID

from mirage.commands.cli.builtin.git.format import short

ROOT_COMMIT = "(root-commit) "
CREATE = "create"
DELETE = "delete"
# git's diffstat geometry for piped output: 80 columns total, binary
# sniffing over the first 8000 bytes, and the 3/8 cap that splits the
# line between the name column and the +/- graph (diff.c show_stats).
STAT_WIDTH = 80
BINARY_SNIFF = 8000
GRAPH_MIN = 6
ELLIPSIS = "..."


@dataclass(frozen=True, slots=True)
class FileStat:
    """One changed path as the diffstat table renders it.

    Args:
        path (str): repository-relative path.
        insertions (int): lines added, 0 for a binary file.
        deletions (int): lines removed, 0 for a binary file.
        binary (bool): whether either side sniffs as binary.
        old_size (int): byte length of the old blob, 0 when created.
        new_size (int): byte length of the new blob, 0 when deleted.
    """
    path: str
    insertions: int
    deletions: int
    binary: bool
    old_size: int
    new_size: int


def tree_entries(store: BaseObjectStore,
                 tree: bytes | None) -> dict[bytes, tuple[int, bytes]]:
    """Every blob a tree holds, keyed by repository-relative path.

    Args:
        store (BaseObjectStore): the object database.
        tree (bytes | None): the tree id, None for the empty tree a
            root commit diffs against.
    """
    if tree is None:
        return {}
    return {
        entry.path: (entry.mode, entry.sha)
        for entry in iter_tree_contents(store, ObjectID(tree))
    }


def _blob_data(store: BaseObjectStore, sha: bytes | None) -> bytes:
    """A blob's bytes, empty when there is nothing to read.

    A gitlink names a commit in another repository, so its id is
    legitimately absent from this store; it reads as empty rather than
    failing the whole table.

    Args:
        store (BaseObjectStore): the object database.
        sha (bytes | None): the blob id, None when the file is being
            created or removed.
    """
    if sha is None:
        return b""
    try:
        obj = store[ObjectID(sha)]
    except KeyError:
        return b""
    return obj.data if isinstance(obj, Blob) else b""


def _count_lines(old_data: bytes, new_data: bytes) -> tuple[int, int]:
    """Line insertions and deletions between two text blobs.

    Args:
        old_data (bytes): the old side's bytes.
        new_data (bytes): the new side's bytes.
    """
    matcher = SequenceMatcher(a=old_data.splitlines(keepends=True),
                              b=new_data.splitlines(keepends=True),
                              autojunk=False)
    insertions = 0
    deletions = 0
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            continue
        deletions += i2 - i1
        insertions += j2 - j1
    return insertions, deletions


def diffstat(store: BaseObjectStore, before: dict[bytes, tuple[int, bytes]],
             after: dict[bytes, tuple[int, bytes]]) -> list[FileStat]:
    """Per-path change counts between two trees, in path order.

    A binary file (NUL in the first 8000 bytes of either side, git's
    own sniff) counts zero lines; a mode-only change counts zero too
    but still occupies a row, which is how git prints ``path | 0``.

    Args:
        store (BaseObjectStore): the object database.
        before (dict): the parent tree, path to (mode, blob id).
        after (dict): the new tree, path to (mode, blob id).
    """
    stats: list[FileStat] = []
    for path in sorted(set(before) | set(after)):
        old = before.get(path)
        new = after.get(path)
        if old == new:
            continue
        old_sha = None if old is None else old[1]
        new_sha = None if new is None else new[1]
        old_data = _blob_data(store, old_sha)
        new_data = _blob_data(store, new_sha)
        binary = (b"\0" in old_data[:BINARY_SNIFF]
                  or b"\0" in new_data[:BINARY_SNIFF])
        if binary or old_sha == new_sha:
            insertions, deletions = 0, 0
        else:
            insertions, deletions = _count_lines(old_data, new_data)
        stats.append(
            FileStat(path=path.decode("utf-8", errors="replace"),
                     insertions=insertions,
                     deletions=deletions,
                     binary=binary,
                     old_size=len(old_data),
                     new_size=len(new_data)))
    return stats


def _scale(value: int, width: int, max_change: int) -> int:
    """git's scale_linear: proportional, but never rounding to zero.

    Args:
        value (int): the count being scaled.
        width (int): the graph's column budget.
        max_change (int): the largest per-file change in the table.
    """
    if not value:
        return 0
    return 1 + value * (width - 1) // max_change


def _stat_name(path: str, name_width: int) -> str:
    """A path fitted to the name column, elided from the left.

    git keeps the tail of a long path, advanced to the next component
    boundary, behind a three-dot prefix.

    Args:
        path (str): repository-relative path.
        name_width (int): the column's width.
    """
    if len(path) <= name_width:
        return path
    tail = path[-(name_width - len(ELLIPSIS)):]
    slash = tail.find("/")
    if slash != -1:
        tail = tail[slash:]
    return f"{ELLIPSIS}{tail}"


def stat_table(stats: list[FileStat], width: int = STAT_WIDTH) -> list[str]:
    """git's diffstat table: one row per path, then the summary line.

    The geometry is diff.c's show_stats pinned against git 2.50 at the
    piped default of 80 columns: the graph is capped at three eighths
    of the line, the name column takes what remains, and per-file
    graphs scale linearly with a floor of one mark per nonzero side.

    Args:
        stats (list[FileStat]): per-path counts from ``diffstat``.
        width (int): total line budget, git's ``--stat-width``.
    """
    if not stats:
        return []
    max_len = max(len(stat.path) for stat in stats)
    max_change = max((stat.insertions + stat.deletions
                      for stat in stats if not stat.binary),
                     default=0)
    number_width = len(str(max_change)) if max_change else 1
    bin_width = max((len(f"Bin {stat.old_size} -> {stat.new_size} bytes") - 4
                     for stat in stats if stat.binary),
                    default=0)
    width = max(width, 16 + 6 + number_width)
    graph_width = max_change if max_change > bin_width else bin_width
    name_width = max_len
    if name_width + number_width + 6 + graph_width > width:
        cap = width * 3 // 8 - number_width - 6
        if graph_width > cap:
            graph_width = max(cap, GRAPH_MIN)
        if name_width > width - number_width - 6 - graph_width:
            name_width = width - number_width - 6 - graph_width
        else:
            graph_width = width - number_width - 6 - name_width
    lines = []
    total_insertions = 0
    total_deletions = 0
    for stat in stats:
        name = _stat_name(stat.path, name_width)
        if stat.binary:
            lines.append(f" {name:<{name_width}} | "
                         f"Bin {stat.old_size} -> {stat.new_size} bytes")
            continue
        total_insertions += stat.insertions
        total_deletions += stat.deletions
        change = stat.insertions + stat.deletions
        added, removed = stat.insertions, stat.deletions
        if change and graph_width <= max_change:
            total = _scale(change, graph_width, max_change)
            if total < 2 and added and removed:
                total = 2
            if added < removed:
                added = _scale(added, graph_width, max_change)
                removed = total - added
            else:
                removed = _scale(removed, graph_width, max_change)
                added = total - removed
        graph = f" {'+' * added}{'-' * removed}" if change else ""
        lines.append(
            f" {name:<{name_width}} | {change:>{number_width}}{graph}")
    lines.append(stat_line(len(stats), total_insertions, total_deletions))
    return lines


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

    The counts come from ``diffstat``, so a binary file adds to the
    file total but zero lines, exactly as git reports it.

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
    stats = diffstat(store, before, after)
    title = commit.message.decode("utf-8", errors="replace").split("\n")[0]
    where = branch if branch is not None else "detached HEAD"
    marker = ROOT_COMMIT if root else ""
    lines = [f"[{where} {marker}{short(commit.id, width)}] {title}"]
    if stats:
        insertions = sum(stat.insertions for stat in stats)
        deletions = sum(stat.deletions for stat in stats)
        lines.append(stat_line(len(stats), insertions, deletions))
    lines.extend(mode_lines(before, after))
    return "".join(f"{line}\n" for line in lines).encode()
