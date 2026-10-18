from collections.abc import AsyncIterator, Mapping
from contextlib import aclosing
from dataclasses import dataclass, field
from string import punctuation
from typing import Literal

from mirage.commands.builtin.utils.operands import (
    merge_split_errors,
    per_operand,
    split_readable,
)
from mirage.commands.builtin.utils.stream import stdin_stat, stdin_stream
from mirage.commands.builtin.utils.strtol import (
    EOVERFLOW_REASON,
    ERANGE_REASON,
    unsigned_decimal,
)
from mirage.commands.config import Context
from mirage.commands.quote import quote_text
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.io.cooperative import chunks
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec, PolymorphicReadFn, StatFn
from mirage.utils.width import TAB_WIDTH


@dataclass(frozen=True, slots=True)
class FmtFlags:
    width: int | None = None
    goal: int | None = None
    prefix: str | None = None
    split_only: bool = False
    tagged: bool = False
    crown: bool = False
    uniform: bool = False


def _width_refusal(text: str, value: int | None) -> str:
    """fmt's refusal of a -w value, past its range a range error.

    Args:
        text (str): the value as typed.
        value (int | None): what it scanned to, None for no number.
    """
    reason = "" if value is None else f": {ERANGE_REASON}"
    return f"fmt: invalid width: '{quote_text(text)}'{reason}"


def _goal_refusal(text: str, value: int | None) -> str:
    """fmt's refusal of a -g value, past the width too large.

    Args:
        text (str): the value as typed.
        value (int | None): what it scanned to, None for no number.
    """
    reason = "" if value is None else f": {EOVERFLOW_REASON}"
    return f"fmt: invalid width: '{quote_text(text)}'{reason}"


def parse_flags(flags: Mapping[str, FlagValue]) -> FmtFlags:
    fl = FlagView(flags, spec=SPECS["fmt"])
    # GNU 9.7 takes -w as a decimal from 0 to 2500, then -g as one from 0
    # to that width.
    width = fl.as_number(
        "width", unsigned_decimal, _width_refusal, low=0, high=_WIDEST
    )
    goal = fl.as_number(
        "goal",
        unsigned_decimal,
        _goal_refusal,
        low=0,
        high=_DEFAULT_WIDTH if width is None else width,
    )
    return FmtFlags(
        width=width,
        goal=goal,
        prefix=fl.as_str("prefix"),
        split_only=fl.as_bool("split_only"),
        tagged=fl.as_bool("tagged_paragraph"),
        crown=fl.as_bool("crown_margin"),
        uniform=fl.as_bool("uniform_spacing"),
    )


_DEFAULT_WIDTH = 75
# GNU 9.7 refuses a -w past 2500.
_WIDEST = 2500

# GNU 9.7 lays a long paragraph out a piece at a time, a piece holding at
# most 998 words and 5000 bytes of word text. It sets the piece, prints its
# first lines, and carries the words of the rest into the next piece,
# whose first line is then also weighed against the line printed
# before it. A piece that fits on one line is printed whole; `_resume`
# says how many lines of a longer one are carried.
_PIECE_WORDS = 998
_PIECE_BYTES = 5000

# What a layout costs, in hundredths of a squared column. The last line laid
# out is free and every other line pays the rest. These values reproduce GNU
# 9.7's choices over the probe corpus, ties going to the shorter line.
# _EACH_LINE is paid per line, _OFF_GOAL per squared column a line misses the
# goal by, and _UNEVEN per squared column a line differs from the one after it.
# A line ending on a word that ends a sentence earns _SENTENCE_END, one ending
# on . ? or ! that ends no sentence pays _FALSE_STOP, one ending on any other
# punctuation earns _MARK_END, and one starting on ( [ ` ' or " earns
# _OPENER_START. _FIRST_ALONE and _LAST_ALONE, over the word's length plus two,
# are paid for ending a line on a sentence's first word or starting one on a
# sentence's last, the paragraph's last word included. _LATER is, per line, how
# much a full piece would rather stop later than earlier.
_EACH_LINE = 4900
_OFF_GOAL = 100
_UNEVEN = 50
_SENTENCE_END = -2500
_FALSE_STOP = 360000
_MARK_END = -1600
_OPENER_START = -1600
_FIRST_ALONE = 40000
_LAST_ALONE = 22500
_LATER = 9

_SPACES = frozenset(b" \t\n\v\f\r")
_CLOSERS = b")]'\""
_OPENERS = frozenset(b"([`'\"")
_STOPS = frozenset(b".?!")
_MARKS = frozenset(punctuation.encode())


def _limits(width: int | None, goal: int | None) -> tuple[int, int]:
    """The width lines stay under and the goal they aim at.

    GNU 9.7 aims at 93.5% of the width, rounded down, and with only a
    goal it allows ten columns past it.

    Args:
        width (int | None): -w, None when not given.
        goal (int | None): -g, None when not given.
    """
    if width is None:
        if goal is not None:
            return goal + 10, goal
        width = _DEFAULT_WIDTH
    return width, width * 187 // 200 if goal is None else goal


def _pad(col: int, target: int, tabs: bool) -> bytes:
    """Blanks from column ``col`` up to ``target``.

    Once the input has shown a tab, GNU 9.7 writes tabs wherever they take
    fewer bytes than spaces: column 7 to 9 stays two spaces, 7 to 16
    becomes two tabs.

    Args:
        col (int): the current column.
        target (int): the column to reach, nothing when not past ``col``.
        tabs (bool): whether tabs may be written.
    """
    if tabs:
        stops = target // TAB_WIDTH - col // TAB_WIDTH
        rest = target % TAB_WIDTH
        if stops > 0 and stops + rest < target - col:
            return b"\t" * stops + b" " * rest
    return b" " * (target - col)


@dataclass(slots=True)
class _Term:
    """One word of a paragraph and how lines may break around it."""

    chars: bytes
    # Columns to the next word when both share a line.
    gap: int
    ends_sentence: bool
    # Ends in . ? or ! without ending a sentence.
    false_stop: bool
    marked: bool
    opener: bool
    # Follows the end of a sentence.
    after_stop: bool


def _join_cost(terms: list[_Term], k: int, final: bool) -> int:
    """What ending a line between ``terms[k]`` and the next word costs.

    Args:
        terms (list[_Term]): the words being laid out.
        k (int): the word the line ends on, never the last.
        final (bool): whether the last of ``terms`` ends the paragraph.
    """
    left = terms[k]
    right = terms[k + 1]
    cost = 0
    if left.ends_sentence:
        cost += _SENTENCE_END
    elif left.false_stop:
        cost += _FALSE_STOP
    elif left.marked:
        cost += _MARK_END
    elif left.after_stop and k:
        # GNU 9.7 does not count a piece's first word as a sentence's.
        cost += _FIRST_ALONE // (len(left.chars) + 2)
    if right.opener:
        cost += _OPENER_START
    elif right.ends_sentence or (final and k + 2 == len(terms)):
        cost += _LAST_ALONE // (len(right.chars) + 2)
    return cost


def _plan(
    terms: list[_Term],
    first_col: int,
    rest_col: int,
    width: int,
    goal: int,
    before: int | None,
    final: bool,
) -> tuple[list[int], list[int]]:
    """Choose where the lines of ``terms`` end.

    Working back from the last word, each word gets the cheapest way to
    lay out everything from it on, and a line is weighed against the
    first line of the remainder chosen after it. GNU 9.7 decides the same
    way, so a layout found this way can differ from the cheapest overall.

    Args:
        terms (list[_Term]): the words, at least one.
        first_col (int): where the first line's text starts.
        rest_col (int): where every other line's text starts.
        width (int): lines of two or more words stay narrower than this.
        goal (int): the length lines aim at.
        before (int | None): the length of the line printed just before
            these words, None at a paragraph's start.
        final (bool): whether the last of ``terms`` ends the paragraph.

    Returns:
        tuple[list[int], list[int]]: the index one past each line's last
        word, and what each line cost as laid out.
    """
    count = len(terms)
    best = [0] * (count + 1)
    stop = [count] * (count + 1)
    reach = [0] * (count + 1)
    joins = [_join_cost(terms, k, final) for k in range(count - 1)]
    for start in range(count - 1, -1, -1):
        length = first_col if start == 0 else rest_col
        for end in range(start + 1, count + 1):
            if end > start + 1:
                length += terms[end - 2].gap
            length += len(terms[end - 1].chars)
            if end > start + 1 and length >= width:
                break
            cost = best[end]
            if end < count:
                cost += _EACH_LINE + _OFF_GOAL * (goal - length) ** 2
                cost += joins[end - 1]
                if stop[end] < count:
                    cost += _UNEVEN * (length - reach[end]) ** 2
            if start == 0 and before is not None:
                cost += _UNEVEN * (length - before) ** 2
            if end == start + 1 or cost < best[start]:
                best[start] = cost
                stop[start] = end
                reach[start] = length
    ends = []
    costs = []
    at = 0
    while at < count:
        costs.append(best[at] - best[stop[at]])
        at = stop[at]
        ends.append(at)
    return ends, costs


def _resume(terms: list[_Term], ends: list[int], costs: list[int]) -> int:
    """Where a full piece stops printing: the word its kept lines start at.

    GNU 9.7 keeps the lines from the one that weighs least as a first
    line: its own cost without the break it ends on, but with the break
    before it, the piece's last line counting as a perfect line, plus a
    little for every line still after it. Ties go to the earlier line.

    Args:
        terms (list[_Term]): the piece's words.
        ends (list[int]): its lines, as `_plan` chose them, two or more.
        costs (list[int]): what each of those lines cost.

    Returns:
        int: the index of the first word carried into the next piece.
    """
    last = len(ends) - 1
    keep = ends[-2]
    lowest = None
    for line in range(1, last + 1):
        start = ends[line - 1]
        if line == last:
            weight = _EACH_LINE
        else:
            weight = costs[line] - _join_cost(terms, ends[line] - 1, False)
        weight += _join_cost(terms, start - 1, False) + _LATER * (last - line)
        if lowest is None or weight < lowest:
            lowest = weight
            keep = start
    return keep


@dataclass(slots=True)
class _Paragraph:
    """Lines joined so far, and what is left of them to print."""

    # Columns of blanks before the prefix, which every line must share.
    lead: int
    first_col: int
    rest_col: int
    lines: int = 1
    terms: list[_Term] = field(default_factory=list)
    size: int = 0
    # Length of the last line printed, for the next piece's first line.
    last: int | None = None
    # Whether the word before the next one ended a sentence.
    after_stop: bool = False


class _Layout:
    """Reflows one input stream, a paragraph at a time.

    A paragraph is printed once a line arrives that does not continue it.
    GNU 9.7 has read that line's leading blanks, prefix and indent by
    then, so a tab among them already counts when the paragraph prints.
    """

    def __init__(
        self,
        width: int,
        goal: int,
        prefix: str | None,
        split_only: bool,
        tagged: bool,
        crown: bool,
        uniform: bool,
    ) -> None:
        self._width = width
        self._goal = goal
        typed = (prefix or "").encode(errors="surrogateescape")
        # GNU 9.7 reads -p ' # ' as '#' at least one column in and followed
        # by at least one blank column; those spaces are not matched as
        # typed, so '\t#\tx' qualifies. A tab in a prefix is matched as
        # typed and counted as one column.
        core = typed.lstrip(b" ")
        self._floor = len(typed) - len(core)
        self._mark = core.rstrip(b" ")
        self._trail = len(core) - len(self._mark)
        self._prefixed = bool(typed)
        self._split = split_only
        self._tagged = tagged
        self._crown = crown
        self._uniform = uniform
        self._tabs = False
        # Where the last paragraph's later lines started; -t starts a
        # one-line paragraph's from there.
        self._hung = 0
        self._para: _Paragraph | None = None
        # The input line being read: "start" until its text or its end,
        # then "copy" for a line printed as it stands or "text" for one
        # whose words join a paragraph; the column read to, whether the
        # blanks just read held a tab, the columns of blanks before the
        # prefix and the bytes of the prefix matched, -1 before it.
        self._mode: Literal["start", "copy", "text"] = "start"
        self._col = 0
        self._tab = False
        self._lead = 0
        self._matched = -1
        # The word being read, the column it starts in and the column
        # after it, -1 while it goes on.
        self._word = bytearray()
        self._start = 0
        self._after = -1

    def feed(self, data: bytes | None) -> bytes:
        """Take more input, or None at its end, and return what it settles.

        Words are read as they come, so a full piece prints before its
        line ends, as GNU 9.7 prints one.

        Args:
            data (bytes | None): the next bytes of the stream.
        """
        out = bytearray()
        if data is None:
            if self._mode == "start" and self._col:
                self._decide(True, False, out)
            self._end(False, out)
            self._close(out)
            return bytes(out)
        pos = 0
        while pos < len(data):
            if self._mode == "start":
                pos = self._head(data, pos, out)
            elif self._mode == "text":
                pos = self._text(data, pos, out)
            else:
                newline = data.find(b"\n", pos)
                if newline < 0:
                    out += data[pos:]
                    break
                out += data[pos:newline]
                self._end(True, out)
                pos = newline + 1
        return bytes(out)

    def _head(self, data: bytes, pos: int, out: bytearray) -> int:
        """Read a line's leading blanks, prefix and indent from ``pos``.

        Args:
            data (bytes): the input.
            pos (int): where to go on from.
            out (bytearray): where the output goes.

        Returns:
            int: where reading stopped, at the line's text or past its end.
        """
        mark = self._mark
        while pos < len(data):
            byte = data[pos]
            if byte == 10:
                self._decide(True, True, out)
                self._end(True, out)
                return pos + 1
            if 0 <= self._matched < len(mark):
                if byte != mark[self._matched]:
                    self._decide(False, False, out)
                    return pos
                self._matched += 1
                self._col += 1
            elif byte == 32:
                self._col += 1
            elif byte == 9:
                self._col += TAB_WIDTH - self._col % TAB_WIDTH
                self._tab = True
            elif self._matched < 0 and mark:
                self._lead = self._col
                self._matched = 0
                continue
            else:
                self._decide(False, False, out)
                return pos
            pos += 1
        return pos

    def _decide(self, bare: bool, ended: bool, out: bytearray) -> None:
        """Settle what the line whose head was just read is.

        Args:
            bare (bool): whether the line ended within its head.
            ended (bool): whether it ended in a newline.
            out (bytearray): where the output goes.
        """
        col = self._col
        tab = self._tab
        mark = self._mark
        if not self._prefixed:
            if bare:
                self._interrupt(tab, out)
                out += b"\n"
                return
            lead = 0
        elif not mark:
            # A prefix of only spaces: GNU 9.7 wants that many columns of
            # leading blanks, and more than that on a line of nothing else.
            # It prints them as the prefix and the rest as indent.
            floor = self._floor
            if col < floor or (bare and col == floor):
                self._interrupt(tab, out)
                if not bare:
                    out += _pad(0, col, self._tabs)
                    self._mode = "copy"
                elif ended:
                    out += b"\n"
                return
            if bare:
                self._interrupt(tab, out)
                out += _pad(0, floor, self._tabs) + b"\n"
                return
            lead = floor
        elif self._matched < len(mark):
            # Copied with its leading blanks rewritten; a line of only
            # blanks prints empty, and a last line without a newline
            # stays without.
            matched = max(self._matched, 0)
            lead = self._lead if matched else col
            self._interrupt(tab, out)
            if matched or not bare:
                out += _pad(0, lead, self._tabs) + mark[:matched]
                self._mode = "copy"
            elif ended:
                out += b"\n"
            return
        else:
            lead = self._lead
            after = lead + len(mark)
            if lead < self._floor or col - after < self._trail:
                # Copied too, but GNU 9.7 also rewrites the blanks it read
                # past the prefix, and ends a bare prefix with a newline.
                self._interrupt(tab, out)
                out += _pad(0, lead, self._tabs) + mark
                if bare:
                    out += b"\n"
                    return
                out += _pad(after, col, self._tabs)
                self._mode = "copy"
                return
            if bare:
                self._interrupt(tab, out)
                out += _pad(0, lead, self._tabs) + mark + b"\n"
                return
        self._tabs |= tab
        para = self._para
        if para is not None and self._joins(para, lead, col):
            para.lines += 1
        else:
            self._close(out)
            self._para = _Paragraph(lead, col, self._hang(col))
        self._mode = "text"
        self._tab = False

    def _end(self, ended: bool, out: bytearray) -> None:
        """Finish the input line being read.

        Args:
            ended (bool): whether it ended in a newline.
            out (bytearray): where the output goes.
        """
        if self._mode == "copy" and ended:
            out += b"\n"
        elif self._mode == "text":
            self._finish(True, out)
        self._mode = "start"
        self._col = 0
        self._tab = False
        self._matched = -1

    def _interrupt(self, tab: bool, out: bytearray) -> None:
        """End the paragraph before a line printed as it stands.

        Args:
            tab (bool): whether the blanks read from that line held a tab.
            out (bytearray): where the output goes.
        """
        self._tabs |= tab
        self._close(out)

    def _hang(self, indent: int) -> int:
        """Where a paragraph's later lines start until its second line says.

        Under -t alone, GNU 9.7 starts them where the last paragraph's
        later lines started, unless that is the first line's own indent:
        then in column 3 when that is column 0, and in column 0 otherwise.

        Args:
            indent (int): the column the first line's text starts in.
        """
        if not self._tagged or self._crown or self._split:
            return indent
        if self._hung == indent:
            return 3 if indent == 0 else 0
        return self._hung

    def _joins(self, para: _Paragraph, lead: int, indent: int) -> bool:
        """Whether a line with these blanks continues ``para``.

        Args:
            para (_Paragraph): the paragraph so far.
            lead (int): columns of blanks before the line's prefix.
            indent (int): the column the line's text starts in.
        """
        if self._split or lead != para.lead:
            return False
        if para.lines > 1:
            return indent == para.rest_col
        # The second line sets where all lines after the first start.
        if self._crown or (self._tagged and indent != para.first_col):
            para.rest_col = indent
            return True
        return not self._tagged and indent == para.first_col

    def _text(self, data: bytes, pos: int, out: bytearray) -> int:
        """Read words from ``pos`` up to the line's end.

        A word runs to the next space, tab, newline, vertical tab, form
        feed or carriage return; only spaces and tabs part it from the
        next, so 'a\rb' holds the words 'a' and '\rb'.

        Args:
            data (bytes): the input.
            pos (int): where to go on from.
            out (bytearray): where a full piece is printed.

        Returns:
            int: where reading stopped, past the line's end or the input's.
        """
        while pos < len(data):
            byte = data[pos]
            if byte == 10:
                self._end(True, out)
                return pos + 1
            if self._word and self._after < 0:
                stop = pos
                while stop < len(data) and data[stop] not in _SPACES:
                    stop += 1
                self._grow(data[pos:stop], out)
                if stop < len(data):
                    self._after = self._col
                pos = stop
                continue
            if byte == 32:
                self._col += 1
            elif byte == 9:
                self._col += TAB_WIDTH - self._col % TAB_WIDTH
                self._tab = True
            else:
                if self._word:
                    self._finish(False, out)
                self._start = self._col
                self._grow(data[pos : pos + 1], out)
            pos += 1
        return pos

    def _grow(self, chars: bytes, out: bytearray) -> None:
        """Add ``chars`` to the word being read.

        GNU 9.7 prints a piece as soon as the word overflows it, before
        reading the rest of the word or the blanks after it.

        Args:
            chars (bytes): the word's next bytes.
            out (bytearray): where a full piece is printed.
        """
        self._word += chars
        self._col += len(chars)
        para = self._para
        assert para is not None
        while para.size + len(self._word) > _PIECE_BYTES:
            if para.terms:
                self._flush(para, self._start, out)
                continue
            # A word filling a whole piece: GNU 9.7 prints as much of it as
            # a piece holds, with no indent and no newline, and goes on
            # with the rest of it as a word of its own, in the column the
            # word started in.
            out += self._word[:_PIECE_BYTES]
            del self._word[:_PIECE_BYTES]
            self._col -= _PIECE_BYTES

    def _finish(self, last: bool, out: bytearray) -> None:
        """Add the word just read, and the blanks after it, to the paragraph.

        Args:
            last (bool): whether the word ends its line.
            out (bytearray): where a full piece is printed.
        """
        para = self._para
        assert para is not None
        chars = bytes(self._word)
        if self._after < 0:
            self._after = self._col
        gap = self._col - self._after
        core = chars.rstrip(_CLOSERS)
        stop = bool(core) and core[-1] in _STOPS
        ends = stop and (last or gap >= 2)
        if last or self._uniform:
            gap = 2 if ends else 1
        if len(para.terms) >= _PIECE_WORDS:
            # GNU 9.7 has read this word's trailing blanks by then.
            self._tabs |= self._tab
            self._flush(para, self._col, out)
        para.terms.append(
            _Term(
                chars=chars,
                gap=gap,
                ends_sentence=ends,
                false_stop=stop and not ends,
                marked=chars[-1] in _MARKS,
                opener=chars[0] in _OPENERS,
                after_stop=para.after_stop,
            )
        )
        para.after_stop = ends
        para.size += len(chars)
        self._tabs |= self._tab
        self._tab = False
        self._word = bytearray()
        self._after = -1

    def _flush(self, para: _Paragraph, col: int, out: bytearray) -> None:
        """Print a full piece of ``para``.

        Under -c or -t, GNU 9.7 then starts the paragraph's later lines,
        whatever its second line said, in the input column it has read to.

        Args:
            para (_Paragraph): the paragraph.
            col (int): the input column read to.
            out (bytearray): where the output goes.
        """
        if (self._crown or self._tagged) and not self._split:
            para.rest_col = col
        self._settle(para, out, final=False)

    def _close(self, out: bytearray) -> None:
        para = self._para
        if para is None:
            return
        if para.lines == 1 and not self._split:
            # A paragraph of one line, its later indent settled now: -c
            # takes the first line's, -t keeps the one it has unless that
            # is the first line's own.
            if self._crown:
                para.rest_col = para.first_col
            elif self._tagged and para.rest_col == para.first_col:
                para.rest_col = 3 if para.first_col == 0 else 0
        self._settle(para, out, final=True)
        self._hung = para.rest_col
        self._para = None

    def _settle(self, para: _Paragraph, out: bytearray, final: bool) -> None:
        """Print what ``para`` holds, but for the lines a full piece carries.

        Args:
            para (_Paragraph): the paragraph.
            out (bytearray): where the output goes.
            final (bool): whether the paragraph has ended.
        """
        terms = para.terms
        if not terms:
            return
        # GNU 9.7 starts every piece's first line in the first line's column.
        ends, costs = _plan(
            terms,
            para.first_col,
            para.rest_col,
            self._width,
            self._goal,
            para.last,
            final,
        )
        keep = 0 if final or len(ends) == 1 else _resume(terms, ends, costs)
        start = 0
        for end in ends:
            if keep and end > keep:
                break
            col = para.rest_col if start else para.first_col
            para.last = self._print(para, start, end, col, out)
            start = end
        del terms[: keep or len(terms)]
        para.size = sum(len(term.chars) for term in terms)

    def _print(
        self, para: _Paragraph, start: int, end: int, col: int, out: bytearray
    ) -> int:
        """Print one line of ``para`` and return its length as laid out.

        A -t indent left of the prefix's end counts as given, though the
        text then starts right after the prefix.

        Args:
            para (_Paragraph): the paragraph.
            start (int): its first word on the line.
            end (int): one past its last.
            col (int): the column the text starts in.
            out (bytearray): where the output goes.
        """
        here = 0
        if self._prefixed:
            out += _pad(0, para.lead, self._tabs) + self._mark
            here = para.lead + len(self._mark)
        out += _pad(here, col, self._tabs)
        here = max(here, col)
        length = col
        for k in range(start, end):
            term = para.terms[k]
            if k > start:
                gap = para.terms[k - 1].gap
                out += _pad(here, here + gap, self._tabs)
                here += gap
                length += gap
            out += term.chars
            here += len(term.chars)
            length += len(term.chars)
        out += b"\n"
        return length


async def fmt(
    paths: list[PathSpec],
    *,
    read_stream: PolymorphicReadFn,
    stdin: ByteSource | None = None,
    width: int | None = None,
    goal: int | None = None,
    prefix: str | None = None,
    split_only: bool = False,
    tagged: bool = False,
    crown: bool = False,
    uniform: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    max_width, goal_width = _limits(width, goal)

    def each(source: ByteSource) -> AsyncIterator[bytes]:
        layout = _Layout(
            max_width, goal_width, prefix, split_only, tagged, crown, uniform
        )
        return _fmt_stream(source, layout)

    io = IOResult()
    read = stdin_stream(read_stream, stdin)
    return per_operand(paths, read, stdin, io, "fmt", each), io


async def _fmt_stream(
    source: ByteSource, layout: _Layout
) -> AsyncIterator[bytes]:
    async with aclosing(chunks(source)) as bounded:
        async for part in bounded:
            settled = layout.feed(part)
            if settled:
                yield settled
    settled = layout.feed(None)
    if settled:
        yield settled


async def fmt_generic(
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    stat: StatFn,
    stream: PolymorphicReadFn,
) -> tuple[ByteSource | None, IOResult]:
    """Run fmt over resolved operands; mirrors fmtGeneric.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by fmt.
        ctx (Context): Flags and stdin from the dispatcher.
        stat (StatFn): Bound stat called as ``stat(path)``.
        stream (PolymorphicReadFn): Bound reader called as
            ``stream(path)``.
    """
    stat = stdin_stat(stat)
    parsed = parse_flags(ctx.flags)
    readable, err = await split_readable(paths, stat, "fmt")
    if err and not readable:
        return None, IOResult(exit_code=1, stderr=err)
    return await merge_split_errors(
        await fmt(
            readable,
            read_stream=stream,
            stdin=ctx.stdin,
            width=parsed.width,
            goal=parsed.goal,
            prefix=parsed.prefix,
            split_only=parsed.split_only,
            tagged=parsed.tagged,
            crown=parsed.crown,
            uniform=parsed.uniform,
        ),
        err,
    )


__all__ = ["fmt", "fmt_generic"]
