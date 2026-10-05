from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.utils.operands import (
    materialized_read,
    merge_split_errors,
    split_readable,
)
from mirage.commands.builtin.utils.stream import (
    read_stdin_async,
    stdin_stat,
    stdin_stream,
)
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec, PolymorphicReadFn, StatFn


@dataclass(frozen=True, slots=True)
class FmtFlags:
    width: int | None = None
    goal: int | None = None
    prefix: str | None = None
    split_only: bool = False
    tagged: bool = False
    crown: bool = False
    uniform: bool = False


def parse_flags(flags: Mapping[str, FlagValue]) -> FmtFlags:
    fl = FlagView(flags, spec=SPECS["fmt"])
    width_value = fl.as_str("width")
    goal_value = fl.as_str("goal")
    return FmtFlags(
        width=int(width_value) if width_value is not None else None,
        goal=int(goal_value) if goal_value is not None else None,
        prefix=fl.as_str("prefix"),
        split_only=fl.as_bool("split_only"),
        tagged=fl.as_bool("tagged_paragraph"),
        crown=fl.as_bool("crown_margin"),
        uniform=fl.as_bool("uniform_spacing"),
    )


WIDTH = 75
LEEWAY = 7
DEF_INDENT = 3
TAB_WIDTH = 8
MAX_WORDS = 1000
MAX_CHARS = 5000
EOF = -1
LINE_COST = 70**2
SENTENCE_BONUS = 50**2
NOBREAK_COST = 600**2
PAREN_BONUS = 40**2
PUNCT_BONUS = 40**2
LINE_CREDIT = 3**2
MAX_COST = 2**63 - 1
OPENERS = b"(['`\""
CLOSERS = b")]'\""
PERIODS = b".?!"
PUNCTUATION = frozenset(b"!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~")
SPACES = frozenset(b" \t\n\v\f\r")


def _short_cost(n: int) -> int:
    return (n * 10) ** 2


def _ragged_cost(n: int) -> int:
    return _short_cost(n) // 2


@dataclass(slots=True)
class _Word:
    start: int
    length: int = 0
    space: int = 0
    paren: bool = False
    punct: bool = False
    period: bool = False
    final: bool = False


class _Formatter:
    """GNU fmt over one file's bytes, ported from coreutils 9.7 fmt.c.

    The C keeps its state in globals; here it is this object's, one per
    file, as fmt() resets ``tabs`` and ``other_indent`` for each.
    """

    def __init__(
        self,
        data: bytes,
        max_width: int,
        goal_width: int,
        prefix: str | None,
        split: bool,
        tagged: bool,
        crown: bool,
        uniform: bool,
    ) -> None:
        self.data = data
        self.pos = 0
        self.max_width = max_width
        self.goal_width = goal_width
        lead = (prefix or "").encode()
        stripped = lead.lstrip(b" ")
        self.prefix_lead_space = len(lead) - len(stripped)
        self.prefix_full_length = len(stripped)
        self.prefix = stripped.rstrip(b" ")
        self.split = split
        self.tagged = tagged
        self.crown = crown
        self.uniform = uniform
        self.out = bytearray()
        self.out_column = 0
        self.in_column = 0
        self.next_prefix_indent = 0
        self.prefix_indent = 0
        self.first_indent = 0
        self.other_indent = 0
        self.last_line_length = 0
        self.tabs = False
        self.next_char = EOF
        self.para = bytearray()
        self.words: list[_Word] = []
        self.best_cost: list[int] = []
        self.next_break: list[int] = []
        self.line_length: list[int] = []

    def run(self) -> bytes:
        self.next_char = self.get_prefix()
        while self.get_paragraph():
            self.fmt_paragraph()
            self.put_paragraph(len(self.words))
        return bytes(self.out)

    def getc(self) -> int:
        if self.pos >= len(self.data):
            return EOF
        c = self.data[self.pos]
        self.pos += 1
        return c

    def get_paragraph(self) -> bool:
        self.last_line_length = 0
        c = self.next_char
        while (
            c in (10, EOF)
            or self.next_prefix_indent < self.prefix_lead_space
            or self.in_column
            < self.next_prefix_indent + self.prefix_full_length
        ):
            c = self.copy_rest(c)
            if c == EOF:
                self.next_char = EOF
                return False
            self.out.append(10)
            c = self.get_prefix()
        self.prefix_indent = self.next_prefix_indent
        self.first_indent = self.in_column
        self.para = bytearray()
        self.words = []
        c = self.get_line(c)
        self.set_other_indent(self.same_para(c))
        if self.split:
            pass
        elif self.crown or self.tagged:
            if self.same_para(c) and (
                self.crown or self.in_column != self.first_indent
            ):
                c = self.get_line(c)
                while (
                    self.same_para(c) and self.in_column == self.other_indent
                ):
                    c = self.get_line(c)
        else:
            while self.same_para(c) and self.in_column == self.other_indent:
                c = self.get_line(c)
        self.words[-1].period = self.words[-1].final = True
        self.next_char = c
        return True

    def copy_rest(self, c: int) -> int:
        self.out_column = 0
        if self.in_column > self.next_prefix_indent or c not in (10, EOF):
            self.put_space(self.next_prefix_indent)
            for byte in self.prefix:
                if self.out_column == self.in_column:
                    break
                self.out.append(byte)
                self.out_column += 1
            if c not in (10, EOF):
                self.put_space(self.in_column - self.out_column)
            if c == EOF and self.in_column >= (
                self.next_prefix_indent + len(self.prefix)
            ):
                self.out.append(10)
        while c not in (10, EOF):
            self.out.append(c)
            c = self.getc()
        return c

    def same_para(self, c: int) -> bool:
        return (
            self.next_prefix_indent == self.prefix_indent
            and self.in_column
            >= self.next_prefix_indent + self.prefix_full_length
            and c not in (10, EOF)
        )

    def get_line(self, c: int) -> int:
        while True:
            word = _Word(start=len(self.para))
            while True:
                if len(self.para) == MAX_CHARS:
                    self.set_other_indent(True)
                    self.flush_paragraph(word)
                self.para.append(c)
                c = self.getc()
                if c == EOF or c in SPACES:
                    break
            word.length = len(self.para) - word.start
            self.in_column += word.length
            self.check_punctuation(word)
            start = self.in_column
            c = self.get_space(c)
            word.space = self.in_column - start
            word.final = c == EOF or (
                word.period and (c == 10 or word.space > 1)
            )
            if c in (10, EOF) or self.uniform:
                word.space = 2 if word.final else 1
            if len(self.words) == MAX_WORDS - 2:
                self.set_other_indent(True)
                self.flush_paragraph(word)
            self.words.append(word)
            if c in (10, EOF):
                break
        return self.get_prefix()

    def get_prefix(self) -> int:
        self.in_column = 0
        c = self.get_space(self.getc())
        if not self.prefix:
            self.next_prefix_indent = min(
                self.prefix_lead_space, self.in_column
            )
            return c
        self.next_prefix_indent = self.in_column
        for byte in self.prefix:
            if c != byte:
                return c
            self.in_column += 1
            c = self.getc()
        return self.get_space(c)

    def get_space(self, c: int) -> int:
        while True:
            if c == 32:
                self.in_column += 1
            elif c == 9:
                self.tabs = True
                self.in_column = (self.in_column // TAB_WIDTH + 1) * TAB_WIDTH
            else:
                return c
            c = self.getc()

    def check_punctuation(self, word: _Word) -> None:
        text = self.para[word.start : word.start + word.length]
        word.paren = text[0] in OPENERS
        word.punct = text[-1] in PUNCTUATION
        finish = len(text) - 1
        while finish > 0 and text[finish] in CLOSERS:
            finish -= 1
        word.period = text[finish] in PERIODS

    def set_other_indent(self, same_paragraph: bool) -> None:
        if self.split:
            self.other_indent = self.first_indent
        elif self.crown:
            self.other_indent = (
                self.in_column if same_paragraph else self.first_indent
            )
        elif self.tagged:
            if same_paragraph and self.in_column != self.first_indent:
                self.other_indent = self.in_column
            elif self.other_indent == self.first_indent:
                self.other_indent = DEF_INDENT if self.first_indent == 0 else 0
        else:
            self.other_indent = self.first_indent

    def flush_paragraph(self, current: _Word) -> None:
        if not self.words:
            self.out += self.para
            self.para = bytearray()
            current.start = 0
            return
        self.fmt_paragraph()
        end = len(self.words)
        split_point = end
        best_break = MAX_COST
        w = self.next_break[0]
        while w != end:
            gain = self.best_cost[w] - self.best_cost[self.next_break[w]]
            if gain < best_break:
                split_point = w
                best_break = gain
            if best_break <= MAX_COST - LINE_CREDIT:
                best_break += LINE_CREDIT
            w = self.next_break[w]
        self.put_paragraph(split_point)
        shift = (
            self.words[split_point].start
            if split_point < end
            else current.start
        )
        self.para = self.para[shift:]
        self.words = self.words[split_point:]
        for word in (*self.words, current):
            word.start -= shift

    def fmt_paragraph(self) -> None:
        words = self.words
        end = len(words)
        self.best_cost = [0] * (end + 1)
        self.next_break = [end] * end
        self.line_length = [0] * end
        for start in range(end - 1, -1, -1):
            best = MAX_COST
            length = self.first_indent if start == 0 else self.other_indent
            w = start
            length += words[w].length
            while True:
                w += 1
                cost = self.line_cost(w, length) + self.best_cost[w]
                if start == 0 and self.last_line_length > 0:
                    cost += _ragged_cost(length - self.last_line_length)
                if cost < best:
                    best = cost
                    self.next_break[start] = w
                    self.line_length[start] = length
                if w == end:
                    break
                length += words[w - 1].space + words[w].length
                if length >= self.max_width:
                    break
            self.best_cost[start] = best + self.base_cost(start)

    def base_cost(self, this: int) -> int:
        words = self.words
        cost = LINE_COST
        if this > 0:
            before = words[this - 1]
            if before.period:
                cost += -SENTENCE_BONUS if before.final else NOBREAK_COST
            elif before.punct:
                cost -= PUNCT_BONUS
            elif this > 1 and words[this - 2].final:
                cost += (200**2) // (before.length + 2)
        if words[this].paren:
            cost -= PAREN_BONUS
        elif words[this].final:
            cost += (150**2) // (words[this].length + 2)
        return cost

    def line_cost(self, following: int, length: int) -> int:
        end = len(self.words)
        if following == end:
            return 0
        cost = _short_cost(self.goal_width - length)
        if self.next_break[following] != end:
            cost += _ragged_cost(length - self.line_length[following])
        return cost

    def put_paragraph(self, finish: int) -> None:
        self.put_line(0, self.first_indent)
        w = self.next_break[0]
        while w != finish:
            self.put_line(w, self.other_indent)
            w = self.next_break[w]

    def put_line(self, w: int, indent: int) -> None:
        self.out_column = 0
        self.put_space(self.prefix_indent)
        self.out += self.prefix
        self.out_column += len(self.prefix)
        self.put_space(indent - self.out_column)
        endline = self.next_break[w] - 1
        while w != endline:
            self.put_word(self.words[w])
            self.put_space(self.words[w].space)
            w += 1
        self.put_word(self.words[w])
        self.last_line_length = self.out_column
        self.out.append(10)

    def put_word(self, word: _Word) -> None:
        self.out += self.para[word.start : word.start + word.length]
        self.out_column += word.length

    def put_space(self, space: int) -> None:
        target = self.out_column + space
        if self.tabs:
            tab_target = target // TAB_WIDTH * TAB_WIDTH
            if self.out_column + 1 < tab_target:
                while self.out_column < tab_target:
                    self.out.append(9)
                    self.out_column = (
                        self.out_column // TAB_WIDTH + 1
                    ) * TAB_WIDTH
        while self.out_column < target:
            self.out.append(32)
            self.out_column += 1


def _widths(width: int | None, goal: int | None) -> tuple[int, int]:
    """``max_width`` and ``goal_width`` as fmt.c's main sets them.

    Args:
        width (int | None): ``-w``.
        goal (int | None): ``-g``.
    """
    max_width = WIDTH if width is None else width
    if goal is None:
        return max_width, max_width * (2 * (100 - LEEWAY) + 1) // 200
    return (goal + 10 if width is None else max_width), goal


async def fmt(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    stdin: ByteSource | None = None,
    width: int | None = None,
    goal: int | None = None,
    prefix: str | None = None,
    split_only: bool = False,
    tagged: bool = False,
    crown: bool = False,
    uniform: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    max_width, goal_width = _widths(width, goal)

    def run(data: bytes) -> bytes:
        return _Formatter(
            data,
            max_width,
            goal_width,
            prefix,
            split_only,
            tagged,
            crown,
            uniform,
        ).run()

    if paths:
        # GNU formats each file on its own: a paragraph never runs from one
        # file into the next.
        return b"".join([run(await read_bytes(p)) for p in paths]), IOResult()
    return run(await read_stdin_async(stdin) or b""), IOResult()


async def fmt_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    stat: StatFn,
    stream: PolymorphicReadFn,
) -> tuple[ByteSource | None, IOResult]:
    """Run fmt over resolved operands; mirrors fmtGeneric.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by fmt.
        opts (CommandOpts): Flags and stdin from the dispatcher.
        stat (StatFn): Bound stat called as ``stat(path)``.
        stream (PolymorphicReadFn): Bound reader called as
            ``stream(path)``.
    """
    stat = stdin_stat(stat)
    stream = stdin_stream(stream, opts.stdin)
    parsed = parse_flags(opts.flags)
    readable, err = await split_readable(paths, stat, "fmt")
    if err and not readable:
        return None, IOResult(exit_code=1, stderr=err)
    return await merge_split_errors(
        await fmt(
            readable,
            read_bytes=materialized_read(stream),
            stdin=opts.stdin,
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
