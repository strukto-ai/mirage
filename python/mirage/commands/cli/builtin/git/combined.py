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

from mirage.commands.cli.builtin.git.constants import FUNCNAME_START, GIT_SPACE

# Measured against git 2.47.3 and 2.50.1. Both print a -U0 hunk that
# reaches past the last line with every count one short, so dropping a
# final line both parents had reads "@@@ -3,0 -3,0 +3,18446744073709551615
# @@@". This prints the counts of the lines shown: "@@@ -3,1 -3,1 +3,0 @@@".
CONTEXT = 3
COMMENT_BYTES = 40

# How many bits of comparison rows the folding of dropped lines keeps at
# once, and how many it spends keeping the bit masks of repeated lines.
ROW_BUDGET = 1 << 26
MASK_BUDGET = 1 << 26

# A parent line the merge dropped, and the parents (as bits) that had it.
Removal = tuple[str, int]


@dataclass(frozen=True, slots=True)
class Layout:
    """The result and, row by row, how each parent differs from it.

    Row ``k`` is result line ``k`` with the parent lines dropped just
    before it; row ``len(result)`` holds what was dropped at the end.

    Args:
        result (list[str]): the merge result's lines, newlines kept.
        newcomers (list[int]): per result line, the parents lacking it.
        gaps (list[list[Removal]]): per row, the lines dropped before it.
        width (int): the number of parents.
    """

    result: list[str]
    newcomers: list[int]
    gaps: list[list[Removal]]
    width: int


@dataclass(frozen=True, slots=True)
class Mark:
    """A changed row.

    Args:
        row (int): the row.
        reach (int): the last line its trailing context covers:
            ``context`` lines past a new line, or ``context`` lines
            from the row's own line when only dropped lines changed.
        kinds (frozenset[int]): the parent bits of each changed line.
    """

    row: int
    reach: int
    kinds: frozenset[int]


def combined_lines(
    parents: list[list[str]],
    result: list[str],
    dense: bool,
    context: int = CONTEXT,
) -> list[str]:
    """The hunks of a combined diff, one column per parent.

    Each parent is compared with the result on its own. A result line
    the parent lacks shows ``+`` in its column, a line it had that the
    merge dropped shows ``-``, and lines several parents dropped at one
    row print once with each of those parents marked.

    A hunk shows ``context`` lines around each changed row and takes in
    the next changed row once their context lines meet or touch. Under
    ``--cc`` the changed rows are first bunched more tightly (the next
    row falls within the trailing context, or right after), and a bunch
    whose every line is new to, or dropped by, the same parents, but not
    all of them, is taken as cleanly merged and left out. Its dropped
    lines still count in the parents' ranges where a shown hunk covers
    their row, as git counts them.

    Args:
        parents (list[list[str]]): each parent's lines, newlines kept.
        result (list[str]): the merge result's lines, newlines kept.
        dense (bool): ``--cc`` rather than ``-c``.
        context (int): the requested number of context lines.
    """
    layout = _compare_sides(parents, result)
    marks = _changed_rows(layout, context)
    if dense:
        every = (1 << layout.width) - 1
        marks = [
            mark
            for bunch in _bunches(marks, 0, 0)
            if _conflicted(bunch, every)
            for mark in bunch
        ]
    before = _lines_before(layout)
    out: list[str] = []
    searched = 0
    for hunk in _bunches(marks, context, 1):
        first = max(hunk[0].row - context, 0)
        last = min(max(max(m.row, m.reach) for m in hunk), len(result))
        label = next(
            (
                result[row]
                for row in range(first - 1, searched - 1, -1)
                if result[row][:1] in FUNCNAME_START
            ),
            None,
        )
        out.extend(
            _render_hunk(layout, hunk, first, last, context, before, label)
        )
        searched = last + 1
    return out


def _compare_sides(parents: list[list[str]], result: list[str]) -> Layout:
    """Compare every parent with the result.

    Args:
        parents (list[list[str]]): each parent's lines, newlines kept.
        result (list[str]): the merge result's lines, newlines kept.
    """
    newcomers = [0] * len(result)
    gaps: list[list[Removal]] = [[] for _ in range(len(result) + 1)]
    for index, lines in enumerate(parents):
        bit = 1 << index
        matcher = SequenceMatcher(a=lines, b=result, autojunk=False)
        for tag, lo, hi, start, stop in matcher.get_opcodes():
            if tag == "equal":
                continue
            for row in range(start, stop):
                newcomers[row] |= bit
            if hi > lo:
                gaps[start] = _coalesce(gaps[start], lines[lo:hi], bit)
    return Layout(result, newcomers, gaps, len(parents))


def _changed_rows(layout: Layout, context: int) -> list[Mark]:
    """Every changed row, in order.

    Args:
        layout (Layout): the compared sides.
        context (int): the requested number of context lines.
    """
    marks = []
    for row, dropped in enumerate(layout.gaps):
        fresh = layout.newcomers[row] if row < len(layout.result) else 0
        if not (fresh or dropped):
            continue
        kinds = {bits for _, bits in dropped}
        if fresh:
            kinds.add(fresh)
        reach = row + context if fresh else row + context - 1
        marks.append(Mark(row, reach, frozenset(kinds)))
    return marks


def _bunches(marks: list[Mark], lead: int, past: int) -> list[list[Mark]]:
    """Split the changed rows into runs.

    A row joins the run before it when, reaching back ``lead`` lines,
    it lands no later than right after the run's last row, or ``past``
    lines after the furthest trailing context in the run.

    Args:
        marks (list[Mark]): the changed rows, in order.
        lead (int): how far a row reaches back.
        past (int): how far past a trailing context still joins.
    """
    runs: list[list[Mark]] = []
    end = 0
    for mark in marks:
        if runs and mark.row - lead <= end:
            runs[-1].append(mark)
        else:
            runs.append([mark])
            end = 0
        end = max(end, mark.reach + past, mark.row + 1)
    return runs


def _conflicted(bunch: list[Mark], every: int) -> bool:
    """Whether ``--cc`` shows a bunch: its lines differ from different
    sets of parents, or some line differs from all of them.

    Args:
        bunch (list[Mark]): neighbouring changed rows.
        every (int): the bits of all parents.
    """
    kinds = frozenset().union(*(mark.kinds for mark in bunch))
    return len(kinds) > 1 or every in kinds


def _lines_before(layout: Layout) -> list[list[int]]:
    """Per row, how many lines of each parent come before it.

    Args:
        layout (Layout): the compared sides.
    """
    seen = [0] * layout.width
    table = []
    for row, dropped in enumerate(layout.gaps):
        table.append(list(seen))
        for _, bits in dropped:
            for index in range(layout.width):
                seen[index] += bits >> index & 1
        if row < len(layout.result):
            for index in range(layout.width):
                seen[index] += 1 - (layout.newcomers[row] >> index & 1)
    return table


def _render_hunk(
    layout: Layout,
    hunk: list[Mark],
    first: int,
    last: int,
    context: int,
    before: list[list[int]],
    label: str | None,
) -> list[str]:
    """One hunk: its header, then rows ``first`` to ``last``.

    A row's dropped lines print when the row is one of the hunk's
    changes and always count. Its line prints, and counts, when some
    change's context covers it; only under -U0 can a row in the middle
    of a hunk go without (a row that only lost lines), and git's header
    still starts at ``first``.

    Args:
        layout (Layout): the compared sides.
        hunk (list[Mark]): the changed rows shown in it.
        first (int): its first row.
        last (int): its last row.
        context (int): the requested number of context lines.
        before (list[list[int]]): :func:`_lines_before`'s table.
        label (str | None): the line the header is named after.
    """
    width = layout.width
    rows = {mark.row for mark in hunk}
    counts = [0] * width
    shown = 0
    body = []
    pending, covered = 0, -1
    for row in range(first, last + 1):
        for line, bits in layout.gaps[row]:
            for index in range(width):
                counts[index] += bits >> index & 1
            if row in rows:
                body.append(_columns(bits, "-", width) + _eol(line))
        while pending < len(hunk) and hunk[pending].row - context <= row:
            covered = max(covered, hunk[pending].reach)
            pending += 1
        if row >= len(layout.result) or row > covered:
            continue
        fresh = layout.newcomers[row]
        for index in range(width):
            counts[index] += 1 - (fresh >> index & 1)
        shown += 1
        body.append(_columns(fresh, "+", width) + _eol(layout.result[row]))
    spans = " ".join(
        f"-{before[first][index] + 1},{counts[index]}"
        for index in range(width)
    )
    fence = "@" * (width + 1)
    header = f"{fence} {spans} +{first + 1},{shown} {fence}"
    return [header + _funcname(label) + "\n", *body]


def _columns(bits: int, sign: str, width: int) -> str:
    """The per-parent prefix: ``sign`` for each parent in ``bits``.

    Args:
        bits (int): the parents to mark.
        sign (str): ``+`` or ``-``.
        width (int): the number of parents.
    """
    return "".join(sign if bits >> i & 1 else " " for i in range(width))


def _coalesce(
    held: list[Removal], dropped: list[str], bit: int
) -> list[Removal]:
    """Fold one more parent's dropped lines into a row.

    The lines pair with the row's earlier ones along a longest common
    subsequence; between two pairs the earlier parents' unpaired lines
    come first, then this parent's.

    Args:
        held (list[Removal]): the row's lines from earlier parents.
        dropped (list[str]): the lines this parent dropped there.
        bit (int): this parent's bit.
    """
    if not held:
        return [(line, bit) for line in dropped]
    pairs = _pairing(
        [_bare(line) for line, _ in held], [_bare(line) for line in dropped]
    )
    merged: list[Removal] = []
    old = new = 0
    for left, right in [*pairs, (len(held), len(dropped))]:
        merged.extend(held[old:left])
        merged.extend((line, bit) for line in dropped[new:right])
        if left < len(held):
            merged.append((held[left][0], held[left][1] | bit))
        old, new = left + 1, right + 1
    return merged


def _bare(line: str) -> str:
    """A line without its newline, so a dropped final line with none
    still pairs with the same line elsewhere.

    Args:
        line (str): the line.
    """
    return line[:-1] if line.endswith("\n") else line


def _pairing(
    left: list[str], right: list[str], budget: int = ROW_BUDGET
) -> list[tuple[int, int]]:
    """Index pairs of equal lines along a longest common subsequence.

    Taken from the ends inward: equal last lines pair, and where
    skipping a line on either side keeps the longest length, the right
    side's line is skipped. So ``a b`` and ``b a`` pair their ``b``s,
    and ``a a`` and ``a`` pair the second ``a``, as git does.

    The walk needs the comparison row of every left line it passes,
    so rather than keeping them all it keeps ``budget`` bits of rows
    and works the rest out again from rows it kept: two passes over
    the lines while ``len(left) * len(right) ** 2`` is under about
    ``budget ** 2 / 4``, one more per halving beyond that, with one
    extra row kept per halving.

    Args:
        left (list[str]): the earlier lines.
        right (list[str]): the lines folded in.
        budget (int): how many bits of rows to keep at once.
    """
    if not (left and right):
        return []
    spots = _Spots(right)
    pairs: list[tuple[int, int]] = []
    _trace(left, spots, 0, len(left), spots.full, len(right), pairs, budget)
    pairs.reverse()
    return pairs


class _Spots:
    """Where each line of ``right`` sits, as bit masks over ``right``.

    A line's mask is built from its positions when a row needs it; the
    masks of lines that repeat are kept while ``MASK_BUDGET`` lasts.

    Args:
        right (list[str]): the lines across the bits.
    """

    def __init__(self, right: list[str]) -> None:
        self.right = right
        self.width = len(right)
        self.full = (1 << self.width) - 1
        self.places: dict[str, list[int]] = {}
        for j, line in enumerate(right):
            self.places.setdefault(line, []).append(j)
        self.kept: dict[str, int] = {}
        self.spare = MASK_BUDGET

    def mask(self, line: str) -> int:
        """The bits of the positions where ``line`` sits in ``right``.

        Args:
            line (str): a line of ``left``.
        """
        kept = self.kept.get(line)
        if kept is not None:
            return kept
        places = self.places.get(line)
        if not places:
            return 0
        if len(places) == 1:
            return 1 << places[0]
        raw = bytearray((self.width + 7) // 8)
        for j in places:
            raw[j >> 3] |= 1 << (j & 7)
        bits = int.from_bytes(raw, "little")
        if self.spare >= self.width:
            self.spare -= self.width
            self.kept[line] = bits
        return bits

    def step(self, row: int, line: str) -> int:
        """The row after ``row`` once ``line`` is added to the left side.

        Bit ``j`` of row ``i`` is clear when ``right[j]`` lengthens the
        longest common subsequence of ``left[:i]`` and
        ``right[:j + 1]``, so a row costs a few integer operations
        rather than a pass over ``right``.

        Args:
            row (int): the row so far.
            line (str): the next line of ``left``.
        """
        hits = row & self.mask(line)
        return ((row + hits) | (row - hits)) & self.full if hits else row


def _trace(
    left: list[str],
    spots: _Spots,
    top: int,
    bottom: int,
    first: int,
    column: int,
    pairs: list[tuple[int, int]],
    budget: int,
) -> int:
    """Walk the pairing back from row ``bottom`` to row ``top``.

    A stretch whose rows fit the budget is walked whole. A longer one
    keeps every ``stride``-th row from one pass and walks the pieces
    from the last up, each worked out afresh from its first row; when
    even those rows overflow half the budget, the stretch is halved
    first.

    Args:
        left (list[str]): the lines down the rows.
        spots (_Spots): the masks over the right side.
        top (int): the row to stop at.
        bottom (int): the row to start from.
        first (int): row ``top``'s bits.
        column (int): the column to start from.
        pairs (list[tuple[int, int]]): the pairs found, last first.
        budget (int): how many bits of rows to keep at once.

    Returns:
        int: the column the walk reaches row ``top`` at, 0 once it
        has run out of right lines.
    """
    span, width = bottom - top, max(spots.width, 1)
    if span <= 1 or (span + 1) * width <= budget:
        rows = [first]
        for i in range(top, bottom):
            rows.append(spots.step(rows[-1], left[i]))
        return _walk(left, spots.right, rows, top, bottom, column, pairs)
    stride = max(budget // (2 * width), 1)
    if -(-span // stride) * width > budget // 2:
        middle = (top + bottom) // 2
        column = _trace(
            left,
            spots,
            middle,
            bottom,
            _advance(spots, left, top, middle, first),
            column,
            pairs,
            budget,
        )
        if not column:
            return 0
        return _trace(left, spots, top, middle, first, column, pairs, budget)
    starts = [first]
    for start in range(top + stride, bottom, stride):
        starts.append(_advance(spots, left, start - stride, start, starts[-1]))
    while starts and column:
        start = top + (len(starts) - 1) * stride
        stop = min(start + stride, bottom)
        column = _trace(
            left, spots, start, stop, starts.pop(), column, pairs, budget
        )
    return column


def _advance(
    spots: _Spots, left: list[str], top: int, stop: int, row: int
) -> int:
    """Row ``stop``'s bits, worked out from row ``top``'s.

    Args:
        spots (_Spots): the masks over the right side.
        left (list[str]): the lines down the rows.
        top (int): the row ``row`` belongs to.
        stop (int): the row wanted.
        row (int): row ``top``'s bits.
    """
    for i in range(top, stop):
        row = spots.step(row, left[i])
    return row


def _walk(
    left: list[str],
    right: list[str],
    rows: list[int],
    top: int,
    row: int,
    column: int,
    pairs: list[tuple[int, int]],
) -> int:
    """Walk the pairing back through rows ``top`` to ``row``.

    ``here`` and ``above`` are the subsequence lengths at the current
    cell and the one above it, kept as the walk moves so that only a
    change of row counts bits.

    Args:
        left (list[str]): the lines down the rows.
        right (list[str]): the lines across the bits.
        rows (list[int]): rows ``top`` to ``row``.
        top (int): the row to stop at.
        row (int): the row to start from.
        column (int): the column to start from.
        pairs (list[tuple[int, int]]): the pairs found, last first.

    Returns:
        int: the column the walk reaches row ``top`` at, 0 once it
        has run out of right lines.
    """
    i, j = row, column
    if i == top or not j:
        return j
    here = _common_length(rows[i - top], j)
    above = _common_length(rows[i - 1 - top], j)
    while i > top and j:
        lower, upper = rows[i - top], rows[i - 1 - top]
        if left[i - 1] == right[j - 1]:
            pairs.append((i - 1, j - 1))
            here = above - 1 + _bit(upper, j - 1)
            i, j = i - 1, j - 1
            if i > top:
                above = _common_length(rows[i - 1 - top], j)
        elif here - 1 + _bit(lower, j - 1) >= above:
            here -= 1 - _bit(lower, j - 1)
            above -= 1 - _bit(upper, j - 1)
            j -= 1
        else:
            here = above
            i -= 1
            if i > top:
                above = _common_length(rows[i - 1 - top], j)
    return j


def _bit(row: int, k: int) -> int:
    """Bit ``k`` of a row.

    Args:
        row (int): a row's bits.
        k (int): the bit wanted.
    """
    return row >> k & 1


def _common_length(row: int, upto: int) -> int:
    """The common-subsequence length a bit row gives ``right[:upto]``.

    Args:
        row (int): a row's bits.
        upto (int): how many lines of ``right`` to count.
    """
    return upto - (row & ((1 << upto) - 1)).bit_count()


def _funcname(line: str | None) -> str:
    """The hunk header's trailing context, cut the way git cuts it.

    git keeps the first 40 bytes up to a newline, then stops BEFORE the
    last non-blank byte, so the context always loses its final byte.

    Args:
        line (str | None): the last line skipped before the hunk that
            starts with a letter, ``_`` or ``$``.
    """
    if line is None:
        return ""
    head = line.encode()[:COMMENT_BYTES].split(b"\n", 1)[0].split(b"\0", 1)[0]
    end = max((i for i, c in enumerate(head) if c not in GIT_SPACE), default=0)
    return " " + head[:end].decode(errors="replace") if end else ""


def _eol(line: str) -> str:
    """A line as printed: always newline-terminated, with no marker.

    Args:
        line (str): the line, with or without its newline.
    """
    return line if line.endswith("\n") else line + "\n"
