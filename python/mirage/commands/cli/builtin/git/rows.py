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

from collections.abc import Iterable
from dataclasses import dataclass

from mirage.commands.cli.builtin.git.tree import Tree
from mirage.commands.cli.builtin.git.types import RepoLocation
from mirage.io.types import ByteSource
from mirage.shell.bytes import encode_text
from mirage.types import PathSpec

# One comparison: the old side's entries, then the new side's.
Side = tuple[Tree, Tree]


@dataclass(frozen=True, slots=True)
class Delta:
    """One path a comparison changed, as the row git hands over.

    Unpaired: a rename is the delete of its source and the add of its
    destination, two rows each naming its own path, so a hide drops
    either side alone and the renderer pairs only what is left.

    Args:
        path (PathSpec): where the entry sits in the session's tree.
        name (bytes): Git's repository-relative name.
        old (tuple[int, bytes] | None): (mode, id) before; None when
            added.
        new (tuple[int, bytes] | None): (mode, id) after; None when
            deleted.
        side (int): which of the command's comparisons it belongs to.
    """

    path: PathSpec
    name: bytes
    old: tuple[int, bytes] | None
    new: tuple[int, bytes] | None
    side: int = 0


def entry_path(location: RepoLocation, name: bytes) -> PathSpec:
    """Where a repository entry sits in the session's tree.

    Args:
        location (RepoLocation): the discovered repository.
        name (bytes): Git's repository-relative name.
    """
    return location.worktree.join(name.decode("utf-8", "surrogateescape"))


def deltas(
    location: RepoLocation, sides: list[Side], first: int = 0
) -> list[Delta]:
    """The paths each comparison changed, one row per path and side.

    A path both sides hold alike is no row: no format prints it, and a
    rename is only ever found among changed paths.

    Args:
        location (RepoLocation): the discovered repository.
        sides (list[Side]): the comparisons, in the order the renderer
            reads them back.
        first (int): the number the first comparison takes, for a
            command that makes its comparisons in batches.
    """
    rows = []
    for side, (before, after) in enumerate(sides, first):
        for name in sorted(set(before) | set(after)):
            old, new = before.get(name), after.get(name)
            if old != new:
                rows.append(
                    Delta(entry_path(location, name), name, old, new, side)
                )
    return rows


def shown_sides(shown: Iterable[Delta], count: int) -> list[Side]:
    """The comparisons again, holding only the rows the session sees.

    A comparison whose every row was dropped comes back empty, which the
    formats read as "does not differ".

    Args:
        shown (Iterable[Delta]): the rows the command boundary kept.
        count (int): how many comparisons the command made.
    """
    sides: list[Side] = [({}, {}) for _ in range(count)]
    for row in shown:
        before, after = sides[row.side]
        if row.old is not None:
            before[row.name] = row.old
        if row.new is not None:
            after[row.name] = row.new
    return sides


@dataclass(frozen=True, slots=True)
class Line:
    """One line a listing prints, and the entry it names.

    Args:
        path (PathSpec): where the entry sits in the session's tree.
        text (str): the line as printed, terminator included.
    """

    path: PathSpec
    text: str


async def printed(shown: list[Line]) -> ByteSource | None:
    """A listing's lines, those the session sees, in order.

    Args:
        shown (list[Line]): the rows the command boundary kept.
    """
    return encode_text("".join(row.text for row in shown)) or None
