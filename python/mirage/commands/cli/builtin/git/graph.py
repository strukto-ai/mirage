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

from collections.abc import Callable, Iterator, Set
from dataclasses import dataclass

from dulwich.objects import Commit

SKIPPED = "..."


@dataclass(eq=False, slots=True)
class _Line:
    """One line of the graph: the edge from a printed commit to the
    commit it leads to, which settles in a column of its own.

    Attributes:
        sha (bytes): the commit the line leads to.
        at (int): the cell it is drawn in, two per column, so an odd
            cell lies between two columns.
        goal (int): the cell of the column it settles in.
        heading (int): -1 while it moves left, 1 while it moves right,
            0 at rest.
    """

    sha: bytes
    at: int
    goal: int
    heading: int = 0


@dataclass(frozen=True, slots=True)
class _Parents:
    """How a commit's parents reach the graph's columns.

    Attributes:
        opened (tuple[bytes, ...]): parents that open a column, the first
            in the commit's own.
        lead (bytes | None): a first parent already waiting to the left,
            whose line leaves straight for it.
        drawn (tuple[bytes, ...]): every parent but the lead, in order:
            the ones a merge's fan and an octopus's dashes count.
        reach (bool): the last parent is the one the column right of the
            commit waits for, and its edge joins that column.
        beside (bool): the second parent waits in the column left of the
            commit and leaves with the lead.
    """

    opened: tuple[bytes, ...]
    lead: bytes | None
    drawn: tuple[bytes, ...]
    reach: bool
    beside: bool


@dataclass(frozen=True, slots=True)
class _Shape:
    """Where a commit lands in the graph.

    Attributes:
        col (int): its column.
        columns (int): the columns there are before it.
        parents (_Parents): how its parents reach the columns.
        after (list[bytes]): the columns after it, before lines leading to
            the same commit join.
        extra (int): the parents an octopus draws past a merge's two.
        spreads (bool): an octopus with lines to its right, which it moves
            right before its own row.
        width (int): the width of its rows.
    """

    col: int
    columns: int
    parents: _Parents
    after: list[bytes]
    extra: int
    spreads: bool
    width: int


class CommitGraph:
    """The ``--graph`` column to the left of a log, one commit at a time.

    Every walked commit moves the graph on; a commit the log does not
    print draws nothing, and the next printed one is preceded by a
    ``...`` row. Lines move one cell per row, skipping a column another
    line stands in, and slide under a run of standing columns with
    ``_``; a printed commit owes the rows its lines need to settle.

    Args:
        interesting (Callable[[bytes], bool]): whether a commit is in
            the walk, so that a line leads to it.
        first_parent (bool): follow only first parents.
    """

    def __init__(
        self, interesting: Callable[[bytes], bool], first_parent: bool
    ) -> None:
        self._interesting = interesting
        self._first_parent = first_parent
        self._lines: list[_Line] = []
        self._pending: Commit | None = None
        self._skipped = False
        self._owed: list[str] = []
        self._ahead: list[str] = []
        self._width = 0
        self._merged_at: int | None = None

    def walk(self, commit: Commit) -> None:
        """Move on to the next walked commit.

        Args:
            commit (Commit): the commit, printed or not.
        """
        if self._pending is not None:
            for _ in self._place(self._pending):
                pass
            self._owed = []
            self._skipped = True
        self._pending = commit

    def lead_in(self) -> str:
        """The rows before the walked commit's own, each with its newline,
        then the cells of its own row, to be followed by its first line;
        once the commit is drawn, the cells in front of a further header.
        """
        commit = self._pending
        if commit is None:
            return self._rest(self._width)
        self._pending = None
        out = self._skip_row(commit) + "\n" if self._skipped else ""
        rows, self._ahead = self._ahead or list(self._place(commit)), []
        star = next(i for i, row in enumerate(rows) if "*" in row)
        self._owed = rows[star + 1 :]
        return out + "".join(row + "\n" for row in rows[:star]) + rows[star]

    def next_row(self) -> str:
        """The cells in front of the commit's next line of text."""
        if self._owed:
            return self._owed.pop(0)
        return self._rest(self._width)

    def filler(self) -> str:
        """The cells in front of a line once the commit's rows are out.

        Before a walked commit yet to be drawn it is the ``...`` row when
        commits were skipped, the commit's first row when it spreads the
        lines to its right, and otherwise a row as wide as the commit's where
        the lines stop. Before a commit leaving with a lead and two or more
        parents besides, the lines right of it stand a cell over, and the row
        widens by the octopus's dashes and a cell.
        """
        commit = self._pending
        if commit is None:
            return self._rest(self._width)
        if self._skipped:
            return self._skip_row(commit)
        shape = self._shape(commit)
        if shape.spreads:
            self._ahead = list(self._place(commit))
            return self._ahead.pop(0)
        parents = shape.parents
        if parents.lead is None or len(parents.drawn) < 2:
            return self._rest(shape.width, settle=True)
        width = max(shape.width, 2 * (shape.columns + shape.extra) + 1)
        return self._rest(width, settle=True, past=2 * shape.col)

    def around(self, text: str) -> str:
        """The commit's text with the graph in front of each further line,
        then the rows the commit still owes.

        Args:
            text (str): the text after the commit's first cells; when it
                ends with a newline the owed rows end with one too.
        """
        lines = text.split("\n")
        out = lines[0]
        for line in lines[1:-1]:
            out += "\n" + self.next_row() + line
        if len(lines) > 1:
            out += "\n" if lines[-1] == "" else "\n" + self.next_row()
            out += lines[-1]
        owed, self._owed = self._owed, []
        if text.endswith("\n"):
            return out + "".join(row + "\n" for row in owed)
        return out + "".join("\n" + row for row in owed)

    def _skip_row(self, commit: Commit) -> str:
        columns = self._columns()
        width = 2 * (len(columns) + (commit.id not in columns))
        self._rest(width, settle=True)
        self._skipped = False
        return SKIPPED.ljust(max(len(SKIPPED), width))

    def _columns(self) -> list[bytes]:
        order = sorted(self._lines, key=lambda line: line.goal)
        return list(dict.fromkeys(line.sha for line in order))

    def _parents_of(
        self, commit: Commit, columns: list[bytes], col: int
    ) -> _Parents:
        followed = commit.parents[:1] if self._first_parent else commit.parents
        parents = list(
            dict.fromkeys(p for p in followed if self._interesting(p))
        )
        where = {sha: i for i, sha in enumerate(columns)}
        opened: list[bytes] = []
        lead: bytes | None = None
        reach = beside = False
        last = len(parents) - 1
        for i, parent in enumerate(parents):
            j = where.get(parent)
            if j is not None and i == 0 and j < col:
                lead = parent
            elif (
                j is not None
                and i == 1
                and lead is not None
                and j == col - 1
                and len(parents) >= 3
            ):
                beside = True
            elif (
                j is not None
                and i == last
                and opened
                and j == col + 1
                and commit.id in where
            ):
                reach = True
            else:
                opened.append(parent)
        drawn = tuple(p for p in parents if p != lead)
        return _Parents(tuple(opened), lead, drawn, reach, beside)

    def _shape(self, commit: Commit) -> _Shape:
        columns = self._columns()
        known = commit.id in columns
        col = columns.index(commit.id) if known else len(columns)
        parents = self._parents_of(commit, columns, col)
        after = columns[:col] + list(parents.opened) + columns[col + 1 :]
        extra = max(len(parents.drawn) - 2, 0)
        spreads = extra > 0 and any(
            line.goal > 2 * col
            for line in self._lines
            if line.sha != commit.id
        )
        # Spreading moves the rightmost line two cells per extra parent,
        # past the columns its parents take when some reach or leave with
        # the lead.
        width = 2 * max(
            len(columns) + (not known),
            len(after),
            len(columns) + extra if spreads else 0,
        )
        return _Shape(col, len(columns), parents, after, extra, spreads, width)

    def _place(self, commit: Commit) -> Iterator[str]:
        """Move the lines through a commit's rows, each row yielded as it is
        drawn, so that a commit the log skips holds none of them.

        Args:
            commit (Commit): the commit.
        """
        shape = self._shape(commit)
        parents, width, extra = shape.parents, shape.width, shape.extra
        here = 2 * shape.col
        final = list(dict.fromkeys(shape.after))
        goal_of = {sha: 2 * i for i, sha in enumerate(final)}
        self._width = width
        opened = len(parents.opened)
        spread = 2 * max(opened - 1, 0)
        others = [line for line in self._lines if line.sha != commit.id]
        right = {id(line) for line in others if line.goal > here}
        base = {
            id(line): line.at + (line.heading if line.at % 2 else 0)
            for line in others
            if id(line) in right
        }
        lift = 2 * extra if shape.spreads else 0
        if lift:
            yield from self._spread_rows(
                others, right, base, here, width, lift
            )
        yield self._commit_row(
            others, right, base, here, width, lift, spread, goal_of, extra
        )
        born = [_Line(sha, here, goal_of[sha]) for sha in parents.opened]
        led = (
            [_Line(parents.lead, here, goal_of[parents.lead])]
            if parents.lead is not None
            else []
        )
        for line in others:
            line.goal = goal_of[line.sha]
        merging = len(parents.drawn) + bool(parents.lead) >= 2
        if merging:
            yield self._merge_row(
                others, right, base, born, led, here, width, spread, parents
            )
        # A reach's edge takes the fan's next cell after the opened parents.
        # That is the spread column's own cell unless a beside parent left
        # the fan a cell short, and then the edge stays a line of its own.
        reached = []
        if parents.reach and parents.beside and lift:
            sha = parents.drawn[-1]
            reached = [_Line(sha, here + 2 * opened, goal_of[sha])]
        self._lines = others + born + led + reached
        self._join()
        self._merged_at = here if merging and self._settled() else None
        while not self._settled():
            yield self._collapse_row(width)

    def _spread_rows(
        self,
        others: list[_Line],
        right: set[int],
        base: dict[int, int],
        here: int,
        width: int,
        lift: int,
    ) -> Iterator[str]:
        for step in range(lift):
            cells = [" "] * width
            cells[here] = "|"
            for line in others:
                if id(line) in right:
                    moving = (
                        step > 0
                        or line.heading > 0
                        or (
                            self._merged_at is not None
                            and line.at > self._merged_at
                        )
                    )
                    line.at = base[id(line)] + step
                    cells[line.at] = "\\" if moving else "|"
                else:
                    if line.at % 2:
                        line.at += line.heading
                    line.heading = 0
                    cells[line.at] = "|"
            yield "".join(cells)

    def _commit_row(
        self,
        others: list[_Line],
        right: set[int],
        base: dict[int, int],
        here: int,
        width: int,
        lift: int,
        spread: int,
        goal_of: dict[bytes, int],
        extra: int,
    ) -> str:
        cells = [" "] * width
        merging = spread > 0
        for line in others:
            goal = goal_of[line.sha]
            on_right = id(line) in right
            if on_right and lift:
                line.at = base[id(line)] + lift
                moving = lift < spread
                glyph = "\\" if moving else "|"
                line.heading = 1 if moving else 0
            elif line.at % 2 or line.heading:
                if line.at % 2:
                    line.at += line.heading
                if (
                    line.heading < 0
                    and goal < line.at
                    and not (on_right and merging)
                ):
                    glyph = "/"
                elif line.heading > 0 and on_right and merging:
                    glyph = "\\"
                else:
                    glyph = "|"
                    line.heading = 0
            else:
                glyph = "|"
                line.heading = 0
            cells[line.at] = glyph
        cells[here] = "*"
        if extra:
            for i in range(2 * extra - 1):
                cells[here + 1 + i] = "-"
            cells[here + 2 * extra] = "."
        return "".join(cells)

    def _merge_row(
        self,
        others: list[_Line],
        right: set[int],
        base: dict[int, int],
        born: list[_Line],
        led: list[_Line],
        here: int,
        width: int,
        spread: int,
        parents: _Parents,
    ) -> str:
        cells = [" "] * width
        for line in others:
            if id(line) in right and line.at < base[id(line)] + spread:
                line.at += 1
                line.heading = 1
                cells[line.at] = "\\"
            else:
                cells[line.at] = "|"
        if born:
            cells[here] = "|"
        for k in range(1, len(parents.drawn)):
            cells[here + 2 * k - 1] = "\\"
        settle = parents.reach and len(parents.drawn) > 2
        for i, line in enumerate(born[1:], start=1):
            if settle:
                line.at = here + 2 * i
                continue
            line.at = here + 2 * i - 1
            line.heading = 1
        if parents.beside:
            cells[here - 1] = "/"
        standing = {
            line.at
            for line in others + born
            if line.at == line.goal and line.heading == 0
        }
        for line in led:
            for cell, glyph in self._step(line, standing, True):
                cells[cell] = glyph
            if line.at == line.goal + 1:
                line.at, line.heading = line.goal, 0
        return "".join(cells)

    def _settled(self) -> bool:
        for line in self._lines:
            if line.at == line.goal:
                continue
            if line.at == line.goal + 1 and line.heading < 0:
                continue
            if line.at == line.goal - 1 and line.heading > 0:
                continue
            return False
        return True

    def _step(
        self,
        line: _Line,
        standing: set[int],
        glide: bool,
        taken: Set[int] = frozenset(),
    ) -> list[tuple[int, str]]:
        """Move a line one row toward its column.

        Args:
            line (_Line): the line.
            standing (set[int]): the cells of columns whose lines stand
                still this row, which a moving line passes under.
            glide (bool): whether the line may slide under a run of them.
            taken (Set[int]): the cells lines start the row in.

        Returns:
            list[tuple[int, str]]: the cells it draws and their glyphs.
        """
        if line.at == line.goal:
            line.heading = 0
            return [(line.at, "|")]
        if line.heading > 0 and line.goal > line.at:
            line.at += 1
            if line.at == line.goal:
                line.heading = 0
                return [(line.at, "|")]
            return [(line.at, "\\")]
        if line.heading > 0:
            line.at += 1
        line.heading = -1
        if line.at % 2:
            line.at -= 1
            if line.at != line.goal and line.at in standing:
                line.at -= 1
            if line.at == line.goal:
                line.heading = 0
                return [(line.at, "|")]
            marks = [(line.at, "/")]
            if line.at % 2 == 0:
                # Landing beside a column whose line already stands there,
                # with the cell past it free, the line slides under it on
                # the same row.
                under = line.at - 2
                if not (
                    glide
                    and under in taken
                    and under - 1 not in taken
                    and under in standing
                    and under > line.goal + 2
                ):
                    return marks
                line.at = under - 1
                marks.append((line.at, "_"))
        else:
            line.at -= 1
            marks = [(line.at, "/")]
        while (
            glide and line.at - 1 in standing and line.at - 1 > line.goal + 2
        ):
            line.at -= 2
            marks.append((line.at, "_"))
        return marks

    def _collapse_row(self, width: int) -> str:
        cells = [" "] * width
        standing = {
            line.goal
            for line in self._lines
            if line.at == line.goal
            or (line.at % 2 and line.at + line.heading == line.goal)
        }
        busy = [
            line.at
            for line in self._lines
            if line.at % 2 and line.heading < 0 and line.at - 1 != line.goal
        ]
        taken = {line.at for line in self._lines}
        for line in sorted(self._lines, key=lambda line: line.at):
            glide = not any(at < line.at for at in busy)
            for cell, glyph in self._step(line, standing, glide, taken):
                if cells[cell] == " " or glyph != "|":
                    cells[cell] = glyph
        self._join()
        return "".join(cells)

    def _join(self) -> None:
        kept: list[_Line] = []
        seen: set[tuple[bytes, int]] = set()
        for line in sorted(
            self._lines, key=lambda line: (line.at, line.heading != 0)
        ):
            key = (line.sha, line.at)
            if line.at == line.goal and key in seen:
                continue
            if line.at == line.goal:
                seen.add(key)
            kept.append(line)
        self._lines = kept

    def _rest(
        self, width: int, settle: bool = False, past: int | None = None
    ) -> str:
        """A row of every line in its column.

        Args:
            width (int): the row's width.
            settle (bool): the lines stop too; otherwise a line still on
                its way keeps going on the next commit's row.
            past (int | None): the lines right of this cell are drawn a
                cell further right.
        """
        self._merged_at = None
        cells = [" "] * width
        for line in self._lines:
            if line.at % 2:
                line.at += line.heading
            if settle:
                line.heading = 0
            at = line.at + (past is not None and line.at > past)
            cells[at] = "|"
        return "".join(cells)
