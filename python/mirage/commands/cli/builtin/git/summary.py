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

from dulwich.object_store import BaseObjectStore
from dulwich.objects import Blob, Commit, ObjectID

from mirage.commands.cli.builtin.git.dates import plural
from mirage.commands.cli.builtin.git.format import short
from mirage.utils.width import text_width

ROOT_COMMIT = "(root-commit) "
# A diffstat is 80 columns wide when the output is not a terminal, and a
# file reads as binary when its first 8000 bytes hold a NUL.
STAT_WIDTH = 80
BINARY_SNIFF = 8000
# The narrowest name column and graph a diffstat shrinks to, how a cut
# name starts, and what a binary row puts in the count column.
NARROWEST_NAME = 10
NARROWEST_GRAPH = 6
ELIDED = "..."
BINARY_COUNT = "Bin"
# What a row spends besides the name, count and graph: the leading space,
# " | ", the space after the count, and the last column, left free.
FRAME = 6
SLASH = b"/"


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
    matcher = SequenceMatcher(
        a=old_data.splitlines(keepends=True),
        b=new_data.splitlines(keepends=True),
        autojunk=False,
    )
    insertions = 0
    deletions = 0
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            continue
        deletions += i2 - i1
        insertions += j2 - j1
    return insertions, deletions


def diffstat(
    store: BaseObjectStore,
    before: dict[bytes, tuple[int, bytes]],
    after: dict[bytes, tuple[int, bytes]],
) -> list[FileStat]:
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
        binary = (
            b"\0" in old_data[:BINARY_SNIFF]
            or b"\0" in new_data[:BINARY_SNIFF]
        )
        if binary or old_sha == new_sha:
            insertions, deletions = 0, 0
        else:
            insertions, deletions = _count_lines(old_data, new_data)
        stats.append(
            FileStat(
                path=path.decode("utf-8", errors="replace"),
                insertions=insertions,
                deletions=deletions,
                binary=binary,
                old_size=len(old_data),
                new_size=len(new_data),
            )
        )
    return stats


def _marks(count: int, graph: int, largest: int) -> int:
    """How many graph columns a scaled count takes: one for anything
    nonzero and its share of the rest, rounded down (git 2.50.1 gives
    the largest change the whole graph and 1 of 1000 lines in a 21-wide
    graph one mark).

    Args:
        count (int): the lines counted.
        graph (int): the graph's width.
        largest (int): the largest change in the table.
    """
    return 1 + count * (graph - 1) // largest if count else 0


def _fitted_name(path: str, column: int) -> str:
    """A path cut to the name column from the left: ``...`` and the
    tail from the next ``/`` on. The cut drops as many bytes as the path
    is columns too wide, which is why git 2.50.1 leaves a path of wide
    characters wider than the column.

    Args:
        path (str): the path as the table shows it.
        column (int): the name column's width.
    """
    shown = text_width(path)
    if shown <= column:
        return path
    over = shown - (column - len(ELIDED))
    tail = path.encode("utf-8", "surrogateescape")[max(over, 0) :]
    slash = tail.find(SLASH)
    if slash >= 0:
        tail = tail[slash:]
    return ELIDED + tail.decode("utf-8", "surrogateescape")


def stat_table(stats: list[FileStat], width: int = STAT_WIDTH) -> list[str]:
    """git's diffstat table: one row per path, then the summary line.

    A row is `` <name> | <count> <graph>``, at most ``width - 1``
    columns, and never narrower than a 10-column name and a 6-column
    graph allow. The count column fits the largest change, and ``Bin``
    when a binary row reads ``Bin <old> -> <new> bytes``, whose text
    after ``Bin`` claims graph room too. When the names and the graph
    do not both fit, a graph needing no more than its share (three
    eighths of the width, less the count column and six) keeps what it
    needs and the names take the rest; a wider one gets that share, at
    least 6 columns, or more if the names are short, and is scaled into
    it: the total, and then the smaller side (deletions on a tie), take
    their marks and the larger side keeps the rest, with two marks at
    least when both are nonzero. Measured against git 2.50.1 and
    2.47.3 over 400 tables at 24 widths each.

    Args:
        stats (list[FileStat]): per-path counts from ``diffstat``.
        width (int): total line budget, git's ``--stat-width``.
    """
    if not stats:
        return []
    texts = [s for s in stats if not s.binary]
    largest = max((s.insertions + s.deletions for s in texts), default=0)
    sizes = [f"{s.old_size} -> {s.new_size} bytes" for s in stats if s.binary]
    count_column = max(len(str(largest)), len(BINARY_COUNT) if sizes else 0)
    wanted = max([largest, *map(len, sizes)])
    widest = max(text_width(s.path) for s in stats)
    width = max(width, NARROWEST_NAME + NARROWEST_GRAPH + count_column + FRAME)
    room = width - FRAME - count_column
    share = width * 3 // 8 - FRAME - count_column
    if widest + wanted <= room:
        graph, column = wanted, widest
    elif wanted <= share:
        graph, column = wanted, room - wanted
    else:
        given = max(NARROWEST_GRAPH, share, room - widest)
        graph, column = min(wanted, given), min(widest, room - given)
    rows = []
    for stat in stats:
        name = _fitted_name(stat.path, column)
        cell = f" {name}{' ' * (column - text_width(name))} | "
        if stat.binary:
            rows.append(
                f"{cell}{BINARY_COUNT:>{count_column}} "
                f"{stat.old_size} -> {stat.new_size} bytes"
            )
            continue
        plus, minus = stat.insertions, stat.deletions
        if largest > graph:
            total = max(
                _marks(plus + minus, graph, largest),
                2 if plus and minus else 0,
            )
            if plus < minus:
                plus = _marks(plus, graph, largest)
                minus = total - plus
            else:
                minus = _marks(minus, graph, largest)
                plus = total - minus
        bar = "+" * plus + "-" * minus
        count = f"{stat.insertions + stat.deletions:>{count_column}}"
        rows.append(f"{cell}{count}{' ' + bar if bar else ''}")
    rows.append(
        stat_line(
            len(stats),
            sum(s.insertions for s in stats),
            sum(s.deletions for s in stats),
        )
    )
    return rows


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
    parts = [f" {plural(files, 'file')} changed"]
    if insertions or not deletions:
        parts.append(plural(insertions, "insertion") + "(+)")
    if deletions or not insertions:
        parts.append(plural(deletions, "deletion") + "(-)")
    return ", ".join(parts)


def report(
    commit: Commit, branch: str | None, changes: bytes, width: int, root: bool
) -> bytes:
    """What ``git commit`` prints once the commit exists.

    The title line, then the counts and ``--summary`` lines that
    ``commit_summary`` renders for the change the commit records.

    Args:
        commit (Commit): the commit just written.
        branch (str | None): the branch it landed on, None when
            detached.
        changes (bytes): the rendered counts and summary lines.
        width (int): how many hex digits to abbreviate the id to.
        root (bool): whether this is the repository's first commit.
    """
    title = commit.message.decode("utf-8", errors="replace").split("\n")[0]
    where = branch if branch is not None else "detached HEAD"
    marker = ROOT_COMMIT if root else ""
    return (
        f"[{where} {marker}{short(commit.id, width)}] {title}\n".encode()
        + changes
    )
