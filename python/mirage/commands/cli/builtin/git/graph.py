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

from collections.abc import Callable, Iterator
from typing import Literal, TypeAlias

from dulwich.objects import Commit

# What the next line of output draws. A commit's lines run SKIP (when
# the one before it never finished), PRE_COMMIT (room for an octopus),
# COMMIT, POST_MERGE (a merge's edges), COLLAPSING (branch lines moving
# left) and PADDING, the resting state between commits.
GraphState: TypeAlias = Literal[
    "padding", "skip", "preCommit", "commit", "postMerge", "collapsing"
]

MERGE_CHARS = ("/", "|", "\\")


class CommitGraph:
    """The ``--graph`` column drawer: git's graph.c, one commit at a time.

    Each column holds the commit its branch line leads to. A commit
    takes its own column (or a new one at the right), its interesting
    parents take its place in the next row's columns, and ``mapping``
    says where each edge of the current row lands in the next, two
    screen cells per column. Lines are drawn until every edge has
    collapsed into its column, which is when the commit is finished and
    the next one may start. Pinned line for line against git 2.50.1 on
    generated histories, trailing spaces included: every line is padded
    to the row's width so text after the graph stays aligned.

    Args:
        interesting (Callable[[bytes], bool]): whether a parent is one
            the walk shows, which is the only kind of parent a line is
            drawn to.
        first_parent_only (bool): ``--first-parent``: a merge draws its
            first parent alone.
    """

    def __init__(
        self, interesting: Callable[[bytes], bool], first_parent_only: bool
    ) -> None:
        self._interesting = interesting
        self._first_parent_only = first_parent_only
        self._commit: bytes = b""
        self._parents: list[bytes] = []
        self._state: GraphState = "padding"
        self._prev_state: GraphState = "padding"
        self._commit_index = 0
        self._prev_commit_index = 0
        self._merge_layout = 0
        self._edges_added = 0
        self._prev_edges_added = 0
        self._width = 0
        self._expansion_row = 0
        self._columns: list[bytes] = []
        self._new_columns: list[bytes] = []
        self._mapping: list[int] = []
        self._old_mapping: list[int] = []
        self._mapping_size = 0

    def update(self, commit: Commit) -> None:
        """Start the next commit's lines; the previous commit's are
        abandoned.

        Args:
            commit (Commit): the commit the walk reached.
        """
        self._commit = commit.id
        if self._first_parent_only:
            first = commit.parents[:1]
            self._parents = [
                parent for parent in first if self._interesting(parent)
            ]
        else:
            self._parents = [
                parent
                for parent in commit.parents
                if self._interesting(parent)
            ]
        self._prev_commit_index = self._commit_index
        self._update_columns()
        self._expansion_row = 0
        # Not _update_state: no line of the new state has been drawn, so
        # the one before it stays whatever was drawn last.
        if self._state != "padding":
            self._state = "skip"
        elif self._needs_pre_commit_line():
            self._state = "preCommit"
        else:
            self._state = "commit"

    def is_finished(self) -> bool:
        """Whether every edge of the current commit has settled."""
        return self._state == "padding"

    def next_line(self) -> tuple[str, bool]:
        """The next line and whether it was the commit's own."""
        shown = False
        if self._state == "padding":
            line = self._padding_row()
        elif self._state == "skip":
            line = self._skip_line()
        elif self._state == "preCommit":
            line = self._pre_commit_line()
        elif self._state == "commit":
            line = self._commit_line()
            shown = True
        elif self._state == "postMerge":
            line = self._post_merge_line()
        else:
            line = self._collapsing_line()
        return line.ljust(self._width), shown

    def padding_line(self) -> str:
        """A line that leaves every branch as it is, for text that runs
        past the commit's own lines; while the commit line is still due
        it draws the current columns, else it is simply the next line.
        """
        if self._state != "commit":
            return self.next_line()[0]
        line = ""
        for column in self._columns:
            line += "|"
            if column == self._commit and len(self._parents) > 2:
                line += " " * ((len(self._parents) - 2) * 2)
            else:
                line += " "
        self._prev_state = "padding"
        return line.ljust(self._width)

    def show_commit(self) -> str:
        """Every line up to and including the commit's own, which ends
        unterminated."""
        if self.is_finished():
            return self.padding_line()
        out = ""
        shown = False
        while not shown and not self.is_finished():
            line, shown = self.next_line()
            out += line
            if not shown:
                out += "\n"
        return out

    def show_message(self, text: str) -> str:
        """A commit's text after its first line, each further line behind
        the next graph line, then whatever lines the commit still owes.

        Args:
            text (str): the text printed after the header.
        """
        parts = text.split("\n")
        out = ""
        for index, part in enumerate(parts):
            out += part
            if index < len(parts) - 1:
                out += "\n"
                if index < len(parts) - 2 or parts[-1] != "":
                    out += self.next_line()[0]
        if self.is_finished():
            return out
        terminated = text.endswith("\n")
        if not terminated:
            out += "\n"
        out += self._remainder()
        if terminated:
            out += "\n"
        return out

    def _remainder(self) -> str:
        """The lines a commit still owes, the last one unterminated."""
        out = ""
        while not self.is_finished():
            out += self.next_line()[0]
            if not self.is_finished():
                out += "\n"
        return out

    def _update_state(self, state: GraphState) -> None:
        self._prev_state = self._state
        self._state = state

    def _dashed_parents(self) -> int:
        """The parents an octopus draws dashes to: every one past the
        first two, one fewer when the merge leans left, since its first
        parent then takes the column beside it."""
        return len(self._parents) + self._merge_layout - 3

    def _needs_pre_commit_line(self) -> bool:
        """Two rows of room for each dashed parent, while there is a
        column to its right."""
        return (
            len(self._parents) >= 3
            and self._commit_index < len(self._columns) - 1
            and self._expansion_row < self._dashed_parents() * 2
        )

    def _is_mapping_correct(self) -> bool:
        for i in range(self._mapping_size):
            target = self._mapping[i]
            if target >= 0 and target != i // 2:
                return False
        return True

    def _row(self) -> Iterator[tuple[int, bytes]]:
        """The cells one row draws, by column: every column, then this
        commit's own when it is in none of them."""
        yield from enumerate(self._columns)
        if self._commit not in self._columns:
            yield len(self._columns), self._commit

    def _update_columns(self) -> None:
        """Lay out the next row: the columns after this commit, and where
        each edge of this row lands in them."""
        self._columns = self._new_columns
        self._new_columns = []
        self._mapping_size = 2 * (len(self._columns) + len(self._parents))
        self._mapping = [-1] * self._mapping_size
        self._width = 0
        self._prev_edges_added = self._edges_added
        self._edges_added = 0
        for i, column in self._row():
            if column == self._commit:
                self._commit_index = i
                self._merge_layout = -1
                for parent in self._parents:
                    self._insert_column(parent, i)
                # A commit takes two cells even when nothing leaves it.
                if not self._parents:
                    self._width += 2
            else:
                self._insert_column(column, -1)
        while (
            self._mapping_size > 1
            and self._mapping[self._mapping_size - 1] < 0
        ):
            self._mapping_size -= 1

    def _insert_column(self, sha: bytes, index: int) -> None:
        """Give a commit a column in the next row, reusing one that
        already leads there, and record where the edge from this row
        lands.

        The first parent of a merge picks the merge's layout: whether its
        edges start one cell left of the commit (the parent sits to the
        left) or at it. An edge the merge added that lands on the last
        column already taken joins it at once rather than running beside
        it for a row.

        Args:
            sha (bytes): the commit the column leads to.
            index (int): the column of the commit whose parent this is,
                -1 for a column carried over.
        """
        if sha in self._new_columns:
            i = self._new_columns.index(sha)
        else:
            i = len(self._new_columns)
            self._new_columns.append(sha)
        if len(self._parents) > 1 and index > -1 and self._merge_layout == -1:
            distance = index - i
            shift = 2 * distance - 3 if distance > 1 else 1
            self._merge_layout = 0 if distance > 0 else 1
            self._edges_added = len(self._parents) + self._merge_layout - 2
            at = self._width + (self._merge_layout - 1) * shift
            self._width += 2 * self._merge_layout
        elif (
            self._edges_added > 0
            and self._width >= 2
            and i == self._mapping[self._width - 2]
        ):
            at = self._width - 2
            self._edges_added = -1
        else:
            at = self._width
            self._width += 2
        while len(self._mapping) <= at:
            self._mapping.append(-1)
        self._mapping[at] = i

    def _padding_row(self) -> str:
        return "| " * len(self._new_columns)

    def _skip_line(self) -> str:
        self._update_state(
            "preCommit" if self._needs_pre_commit_line() else "commit"
        )
        return "..."

    def _pre_commit_line(self) -> str:
        """One of the rows that widen the space around an octopus merge."""
        line = ""
        seen_this = False
        for i, column in enumerate(self._columns):
            if column == self._commit:
                seen_this = True
                line += "|" + " " * self._expansion_row
            elif seen_this and self._expansion_row == 0:
                line += (
                    "\\"
                    if self._prev_state == "postMerge"
                    and self._prev_commit_index < i
                    else "|"
                )
            elif seen_this and self._expansion_row > 0:
                line += "\\"
            else:
                line += "|"
            line += " "
        self._expansion_row += 1
        if not self._needs_pre_commit_line():
            self._update_state("commit")
        return line

    def _commit_line(self) -> str:
        line = ""
        seen_this = False
        for i, column in self._row():
            if column == self._commit:
                seen_this = True
                line += "*"
                if len(self._parents) > 2:
                    line += self._octopus_dashes()
            elif seen_this and self._edges_added > 1:
                line += "\\"
            elif seen_this and self._edges_added == 1:
                line += (
                    "\\"
                    if self._prev_state == "postMerge"
                    and self._prev_edges_added > 0
                    and self._prev_commit_index < i
                    else "|"
                )
            elif (
                self._prev_state == "collapsing"
                and _at(self._old_mapping, 2 * i + 1) == i
                and _at(self._mapping, 2 * i) < i
            ):
                line += "/"
            else:
                line += "|"
            line += " "
        if len(self._parents) > 1:
            self._update_state("postMerge")
        elif self._is_mapping_correct():
            self._update_state("padding")
        else:
            self._update_state("collapsing")
        return line

    def _octopus_dashes(self) -> str:
        dashed = self._dashed_parents()
        return "".join(
            "-." if i == dashed - 1 else "--" for i in range(dashed)
        )

    def _post_merge_line(self) -> str:
        first_parent = self._parents[0] if self._parents else None
        line = ""
        seen_this = False
        parent_seen = False
        for i, column in self._row():
            if column == self._commit:
                seen_this = True
                at = self._merge_layout
                for j in range(len(self._parents)):
                    line += MERGE_CHARS[at]
                    if at == 2:
                        if self._edges_added > 0 or j < len(self._parents) - 1:
                            line += " "
                    else:
                        at += 1
                if self._edges_added == 0:
                    line += " "
            elif seen_this:
                line += "\\ " if self._edges_added > 0 else "| "
            else:
                line += "|"
                if self._merge_layout != 0 or i != self._commit_index - 1:
                    line += "_" if parent_seen else " "
            if column == first_parent:
                parent_seen = True
        self._update_state(
            "padding" if self._is_mapping_correct() else "collapsing"
        )
        return line

    def _collapsing_line(self) -> str:
        """Move every edge not yet in its column one cell left, crossing
        at most one other edge; a single edge may instead run
        horizontally (``_``) across the columns between it and its
        target."""
        horizontal_edge = -1
        horizontal_target = -1
        used_horizontal = False
        self._mapping, self._old_mapping = self._old_mapping, self._mapping
        size = self._mapping_size
        if len(self._mapping) < size:
            self._mapping.extend([-1] * (size - len(self._mapping)))
        for i in range(size):
            self._mapping[i] = -1
        for i in range(size):
            target = _at(self._old_mapping, i)
            if target < 0:
                continue
            if target * 2 == i:
                self._mapping[i] = target
            elif self._mapping[i - 1] < 0:
                self._mapping[i - 1] = target
                if horizontal_edge == -1:
                    horizontal_edge = i
                    horizontal_target = target
                    for j in range(target * 2 + 3, i - 2, 2):
                        self._mapping[j] = target
            elif self._mapping[i - 1] == target:
                continue
            else:
                self._mapping[i - 2] = target
                if horizontal_edge == -1:
                    horizontal_target = target
                    horizontal_edge = i - 1
                    for j in range(target * 2 + 3, i - 2, 2):
                        self._mapping[j] = target
        self._old_mapping = self._mapping[:size]
        if self._mapping[size - 1] < 0:
            self._mapping_size -= 1
        line = ""
        for i in range(self._mapping_size):
            target = self._mapping[i]
            if target < 0:
                line += " "
            elif target * 2 == i:
                line += "|"
            elif target == horizontal_target and i != horizontal_edge - 1:
                # Only the first segment of a horizontal run carries into
                # the next line; the rest were drawn here and are done.
                if i != target * 2 + 3:
                    self._mapping[i] = -1
                used_horizontal = True
                line += "_"
            else:
                if used_horizontal and i < horizontal_edge:
                    self._mapping[i] = -1
                line += "/"
        if self._is_mapping_correct():
            self._update_state("padding")
        return line


def _at(values: list[int], index: int) -> int:
    """One slot of a mapping, -1 past its end.

    Args:
        values (list[int]): the mapping.
        index (int): the slot.
    """
    return values[index] if 0 <= index < len(values) else -1
