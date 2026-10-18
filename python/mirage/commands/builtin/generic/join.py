import re
from collections.abc import (
    AsyncGenerator,
    Awaitable,
    Callable,
    Mapping,
    Sequence,
)
from contextlib import aclosing
from dataclasses import dataclass, field
from enum import Enum
from typing import NoReturn

from mirage.commands.builtin.utils.lines import record_separator
from mirage.commands.builtin.utils.stream import (
    is_stdin,
    never_opened,
    stdin_stream,
)
from mirage.commands.builtin.utils.strtol import unsigned_decimal
from mirage.commands.config import Context
from mirage.commands.errors import UsageError
from mirage.commands.quote import quote_text
from mirage.commands.spec import SPECS
from mirage.commands.spec.constants import OPERAND, SPELLED
from mirage.commands.spec.flag_view import FlagView, spread_operands
from mirage.commands.spec.types import CommandName, FlagValue
from mirage.commands.spec.usage import (
    extra_operand_error,
    missing_operand_error,
)
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import fs_strerror
from mirage.errors.render import fs_error_line
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.types import ByteSource, IOResult
from mirage.shell.bytes import encode_text
from mirage.types import PathSpec, PolymorphicReadFn

# The largest field number join keeps; GNU 9.7 reads any larger one as
# this one, so `-1 99999999999999999999 -1 1` is refused as
# "incompatible join fields 9223372036854775806, 0".
LARGEST_FIELD = 2**63 - 1
# Without -t a field is a run of bytes other than space and tab, and
# under -z a newline parts fields too (`printf '1\na\0'` is `1` and `a`).
# Every other byte, \v, \f and \r included, belongs to a field.
BLANK_SPLIT = re.compile(rb"[^ \t]+")
BLANK_SPLIT_NUL = re.compile(rb"[^ \t\n]+")
# The -t value that keeps each record whole: both `-t ''` and `-t $'\n'`
# select it, under -z as well, and they never conflict with each other.
WHOLE_RECORD = b"\n"
# One -o item from the next: a single comma, space or tab.
COLUMN_BREAK = re.compile(r"[, \t]")
# The -o column standing for the join field.
JOIN_COLUMN = (0, 0)
# Output is handed on in pieces of about this size.
CHUNK = 1 << 16
OPTION_DESTS = (
    "a",
    "v",
    "e",
    "ignore_case",
    "args_1",
    "2",
    "j",
    "o",
    "t",
    "zero_terminated",
    "check_order",
    "nocheck_order",
    "header",
)
LONE_J_WORDS = {"-j1": 1, "-j2": 2}


class OrderCheck(Enum):
    """What join does with a line whose key sorts before the one above it.

    WARN, the default, names the first such line of each file, but only
    once some line has gone unpaired, then finishes and exits 1 under
    ``input is not in sorted order``. FAIL (``--check-order``) names the
    first one and stops there. OFF (``--nocheck-order``) never looks.
    """

    WARN = "warn"
    FAIL = "fail"
    OFF = "off"


@dataclass(frozen=True)
class JoinFlags:
    """join's options as one line set them.

    Attributes:
        keys (tuple[int, int]): each file's join field, counted from 0.
        unpaired (tuple[bool, bool]): whether each file's unpairable lines
            print (``-a``, ``-v``).
        paired (bool): whether joined lines print; any ``-v`` clears it.
        filler (bytes | None): the ``-e`` text for an empty field.
        columns (tuple[tuple[int, int], ...]): the ``-o`` list, each item
            a file number and a field counted from 0; file 0 is the join
            field.
        auto_columns (bool): ``-o auto``.
        delimiter (bytes | None): the ``-t`` byte; None parts fields at
            runs of blanks and WHOLE_RECORD keeps each record whole.
        separator (bytes): what output fields are joined with.
        fold_case (bool): ``-i``.
        terminator (bytes): what ends a record, NUL under ``-z``.
        order (OrderCheck): what an unsorted line does.
        header (bool): ``--header``.
        files (tuple[int, int]): the operand positions of FILE1 and FILE2.
    """

    keys: tuple[int, int] = (0, 0)
    unpaired: tuple[bool, bool] = (False, False)
    paired: bool = True
    filler: bytes | None = None
    columns: tuple[tuple[int, int], ...] = ()
    auto_columns: bool = False
    delimiter: bytes | None = None
    separator: bytes = b" "
    fold_case: bool = False
    terminator: bytes = b"\n"
    order: OrderCheck = OrderCheck.WARN
    header: bool = False
    files: tuple[int, int] = (0, 1)


def _refusal(message: str) -> UsageError:
    return UsageError(f"join: {message}", 1)


def _field_index(text: str) -> int:
    """A field number as join reads one, counted from 0.

    C blanks, one plus sign and decimal digits, nothing after them, and
    never zero: `-1 ' 2'` and `-1 +2` are field 2, `-1 '2 '` and `-1 0`
    are refused.

    Args:
        text (str): the number as typed.
    """
    value = unsigned_decimal(text)
    if not value:
        raise _refusal(f"invalid field number: '{quote_text(text)}'")
    return min(value, LARGEST_FIELD) - 1


def _file_number(text: str) -> int:
    """The 1 or 2 that -a and -v take, read like a field number.

    Args:
        text (str): the number as typed.
    """
    value = unsigned_decimal(text)
    if value not in (1, 2):
        raise _refusal(f"invalid file number: '{quote_text(text)}'")
    return value


def _column(item: str) -> tuple[int, int]:
    """One -o item: ``0`` for the join field, else ``FILE.FIELD``.

    GNU 9.7 sorts a bad item by its first byte: one led by 0, 1 or 2 is
    an "invalid field specifier" (`01.1`, `1`, `2x`), any other an
    "invalid file number in field spec" (`3.1`, `.1`, `auto,1.1`), and
    the text after `1.` or `2.` must be a field number.

    Args:
        item (str): the item as typed.
    """
    if item == "0":
        return JOIN_COLUMN
    lead = item[:1]
    if lead in ("1", "2") and item[1:2] == ".":
        return int(lead), _field_index(item[2:])
    if lead in ("0", "1", "2"):
        raise _refusal(f"invalid field specifier: '{quote_text(item)}'")
    raise _refusal(f"invalid file number in field spec: '{quote_text(item)}'")


@dataclass
class _LoneJ:
    """A ``-j1`` or ``-j2`` typed as a word of its own.

    Attributes:
        file (int): the 1 or 2 it spells.
        claimed (bool): the operand after it was taken as its field.
    """

    file: int
    claimed: bool = False


@dataclass
class _Operand:
    """An operand standing as a file name.

    Attributes:
        position (int): its place among the line's operands.
        word (str): the operand as typed.
        lone (_LoneJ | None): the lone ``-jN`` typed right before it,
            which may still take it as a field number.
        listed (bool): it came straight after an ``-o`` list, or after an
            operand that did, so it may still be more of that list.
    """

    position: int
    word: str
    lone: _LoneJ | None = None
    listed: bool = False


@dataclass
class _Reading:
    """The options read so far, in the order the line typed them."""

    words: Sequence[str]
    seen: int = 0
    names: list[_Operand] = field(default_factory=list)
    lone: list[_LoneJ] = field(default_factory=list)
    keys: list[int | None] = field(default_factory=lambda: [None, None])
    unpaired: list[bool] = field(default_factory=lambda: [False, False])
    paired: bool = True
    filler: bytes | None = None
    columns: list[tuple[int, int]] = field(default_factory=list)
    auto_columns: bool = False
    delimiter: bytes | None = None
    separator: bytes = b" "
    fold_case: bool = False
    terminator: bytes = record_separator(False)
    order: OrderCheck = OrderCheck.WARN
    header: bool = False

    def set_key(self, side: int, index: int) -> None:
        held = self.keys[side]
        if held is not None and held != index:
            raise _refusal(f"incompatible join fields {held}, {index}")
        self.keys[side] = index

    def operand(self, word: str, lone: _LoneJ | None, listed: bool) -> None:
        """File one operand, making room when two are already filed.

        A third operand gives the earliest filed one that could be an
        option's value to that option: the field number of the lone
        ``-jN`` before it (`join -j1 2 a b` is `-1 2 a b`), or more of the
        ``-o`` list (`join -o 1.1 2.2 a b` is `-o 1.1,2.2 a b`), appended
        where the list then ends. With no such operand it is an extra one.

        Args:
            word (str): the operand as typed.
            lone (_LoneJ | None): the lone ``-jN`` typed right before it.
            listed (bool): it continues an ``-o`` list's run of operands.
        """
        position = self.seen
        self.seen += 1
        if position < len(self.words):
            word = self.words[position]
        if len(self.names) == 2:
            taken = next((n for n in self.names if n.lone or n.listed), None)
            if taken is None:
                raise extra_operand_error(CommandName.JOIN, word)
            self.names.remove(taken)
            if taken.lone is not None:
                taken.lone.claimed = True
                self.set_key(taken.lone.file - 1, _field_index(taken.word))
            else:
                self.add_items(taken.word)
        self.names.append(_Operand(position, word, lone, listed))

    def option(self, name: str, value: FlagValue) -> None:
        if value is False:
            return
        text = "" if value is True else str(value)
        if name in ("a", "v"):
            self.unpaired[_file_number(text) - 1] = True
            self.paired = self.paired and name == "a"
        elif name == "e":
            filler = encode_text(text)
            if self.filler is not None and self.filler != filler:
                raise _refusal("conflicting empty-field replacement strings")
            self.filler = filler
        elif name in ("args_1", "2"):
            self.set_key(0 if name == "args_1" else 1, _field_index(text))
        elif name == "j":
            index = _field_index(text)
            self.set_key(0, index)
            self.set_key(1, index)
        elif name == "o":
            self.add_columns(text)
        elif name == "t":
            self.set_delimiter(text)
        elif name == "ignore_case":
            self.fold_case = True
        elif name == "zero_terminated":
            self.terminator = record_separator(True)
        elif name in ("check_order", "nocheck_order"):
            self.order = (
                OrderCheck.FAIL if name == "check_order" else OrderCheck.OFF
            )
        elif name == "header":
            self.header = True

    def add_columns(self, text: str) -> None:
        # Only the whole value `auto` is auto.
        if text == "auto":
            self.auto_columns = True
        else:
            self.add_items(text)

    def add_items(self, text: str) -> None:
        # One separator may close the list (`-o '1.1,'`); any other empty
        # item is refused.
        items = COLUMN_BREAK.split(text)
        if len(items) > 1 and items[-1] == "":
            items.pop()
        self.columns.extend(_column(item) for item in items)

    def set_delimiter(self, text: str) -> None:
        # `-t ''` keeps records whole but leaves the output separator as
        # it was; `\0` is NUL; any other value must be one byte.
        raw = encode_text(text)
        if raw == b"":
            byte = WHOLE_RECORD
        elif raw == b"\\0":
            byte = b"\0"
        elif len(raw) == 1:
            byte = raw
        else:
            raise _refusal(f"multi-character tab '{quote_text(text)}'")
        if self.delimiter is not None and self.delimiter != byte:
            raise _refusal("incompatible tabs")
        self.delimiter = byte
        if raw:
            self.separator = byte

    def finish(self, argv: Sequence[str]) -> JoinFlags:
        """Check the operands, then apply the lone ``-jN`` words left.

        A lone ``-jN`` whose operand stayed a file name is ``-j N``, and
        GNU 9.7 applies those after every other option, every ``-j1``
        before every ``-j2``: `join -j2 a -j1 b` is refused as
        "incompatible join fields 0, 1".

        Args:
            argv (Sequence[str]): the line's words after ``join``.
        """
        if len(self.names) < 2 and (self.seen or argv):
            last = self.names[-1].word if self.names else None
            raise missing_operand_error(CommandName.JOIN, last, argv)
        for number in (1, 2):
            if any(j.file == number and not j.claimed for j in self.lone):
                self.set_key(0, number - 1)
                self.set_key(1, number - 1)
        files = (
            (self.names[0].position, self.names[1].position)
            if len(self.names) == 2
            else (0, 1)
        )
        first, second = (0 if key is None else key for key in self.keys)
        return JoinFlags(
            keys=(first, second),
            unpaired=(self.unpaired[0], self.unpaired[1]),
            paired=self.paired,
            filler=self.filler,
            columns=tuple(self.columns),
            auto_columns=self.auto_columns,
            delimiter=self.delimiter,
            separator=self.separator,
            fold_case=self.fold_case,
            terminator=self.terminator,
            order=self.order,
            header=self.header,
            files=files,
        )


def parse_flags(
    flags: Mapping[str, FlagValue],
    operands: Sequence[str] = (),
    argv: Sequence[str] = (),
) -> JoinFlags:
    """Read join's options and operands in the order the line typed them.

    GNU join meets its options and operands in one pass, so the first
    problem left to right is the one reported: `join a b c -a 3` names
    the extra operand, `join -a 3 a b c` the file number. A ``-j1`` or
    ``-j2`` typed as one word and followed at once by an operand may be
    the obsolete ``-j1 FIELD``, and the operands right after an ``-o``
    list may be more of it: such an operand is taken as the value only
    when a third operand needs the room (`join -j1 2 a b`), and stays a
    file name otherwise (`join -j1 a b` is `join -j 1 a b`).

    Args:
        flags (Mapping[str, FlagValue]): the parsed flags and their tape.
        operands (Sequence[str]): the operands as typed, in order; when
            the tape places none, they are read after every option.
        argv (Sequence[str]): the line's words after ``join``, which the
            missing-operand line names the last of.
    """
    reading = _Reading(operands)
    spelled: str | None = None
    fresh: _LoneJ | None = None
    listing = False
    tape = FlagView(flags, SPECS[CommandName.JOIN]).occurrences(
        OPERAND, SPELLED, *OPTION_DESTS
    )
    for name, value in tape:
        after_word, spelled = spelled, None
        after_lone, fresh = fresh, None
        after_list, listing = listing, False
        if name == SPELLED:
            spelled = str(value)
        elif name == OPERAND:
            reading.operand(str(value), after_lone, after_list)
            listing = after_list
        elif name == "j" and after_word in LONE_J_WORDS:
            fresh = _LoneJ(LONE_J_WORDS[after_word])
            reading.lone.append(fresh)
        else:
            reading.option(name, value)
            listing = name == "o" and value != "auto"
    # A mapping with no tape (a direct call) places no operand: the
    # operands it was given then follow every option, as plain files.
    if reading.seen == 0:
        for word in operands:
            reading.operand(word, None, False)
    return reading.finish(argv)


class _Halt(Exception):
    """The run stops here; what it printed so far still goes out."""


@dataclass
class _Line:
    """One record of an input, split into fields.

    Attributes:
        text (bytes): the record without its terminator.
        fields (list[bytes]): its fields; an empty record has none.
        key (bytes): its join field, empty when the record is short.
        rank (bytes): what it sorts by: the key, upper-cased in ASCII
            under ``-i`` (so `_` sorts after `A`).
    """

    text: bytes
    fields: list[bytes]
    key: bytes
    rank: bytes


@dataclass
class _Input:
    """One of the two files and how far its order check has come.

    Attributes:
        name (bytes): the operand as typed, for diagnostics.
        path (PathSpec): the operand.
        reader (AsyncLineIterator): its records.
        key (int): its join field.
        shown (bool): whether its unpairable lines print.
        count (int): records read so far, the header included.
        last (bytes | None): the rank of the record before, None while
            nothing is there to compare with.
        reported (bool): its disorder has been reported.
        line (_Line | None): the record in hand, None past the end.
        chunk (bytes): the reader's latest chunk.
        start (int): where the next record begins in ``chunk``.
        cut (int): where it ends, -1 while its terminator has not come.
        held (list[bytes]): the start of a record that began in earlier
            chunks, kept as it came so a long record is copied once.
        drained (bool): the reader has nothing more to give.
    """

    name: bytes
    path: PathSpec
    reader: AsyncLineIterator
    key: int
    shown: bool
    count: int = 0
    last: bytes | None = None
    reported: bool = False
    line: _Line | None = None
    chunk: bytes = b""
    start: int = 0
    cut: int = -1
    held: list[bytes] = field(default_factory=list)
    drained: bool = False


class _Join:
    """Walk two sorted inputs side by side and print what pairs up.

    Args:
        flags (JoinFlags): the options.
        names (tuple[bytes, bytes]): each operand as typed.
        readers (tuple[AsyncLineIterator, AsyncLineIterator]): the inputs.
        paths (tuple[PathSpec, PathSpec]): the operands.
    """

    def __init__(
        self,
        flags: JoinFlags,
        names: tuple[bytes, bytes],
        readers: tuple[AsyncLineIterator, AsyncLineIterator],
        paths: tuple[PathSpec, PathSpec],
    ) -> None:
        self.flags = flags
        self.inputs = readers
        self.sides = tuple(
            _Input(names[n], paths[n], readers[n], flags.keys[n], shown)
            for n, shown in enumerate(flags.unpaired)
        )
        self._blanks = (
            BLANK_SPLIT_NUL if flags.terminator == b"\0" else BLANK_SPLIT
        )
        self._layout: list[tuple[int, int]] | None = (
            list(flags.columns) if flags.columns else None
        )
        self._out = bytearray()
        self._errors = bytearray()
        self._status = 0
        # Whether a line has gone unpaired yet; the default order check
        # stays quiet until then.
        self._lone_seen = False

    def outcome(self) -> tuple[int, bytes]:
        return self._status, bytes(self._errors)

    def _take(self) -> bytes:
        data = bytes(self._out)
        self._out.clear()
        return data

    async def run(self) -> AsyncGenerator[bytes, None]:
        # Every record is taken through _in_hand, and when one is not,
        # _refill hands on what is printed before it waits for input.
        try:
            first, second = self.sides
            await self._open()
            for side in self.sides:
                if not self._in_hand(side):
                    async for chunk in self._refill(side):
                        yield chunk
                self._advance(side)
            if self.flags.header and (first.line or second.line):
                # The header lines are printed even under -v, the lone one
                # when the other file is empty, and nothing after them is
                # compared with them.
                self._settle_layout(first.line, second.line)
                self._print_header(first.line, second.line)
                first.last = second.last = None
                for side in self.sides:
                    if not self._in_hand(side):
                        async for chunk in self._refill(side):
                            yield chunk
                    self._advance(side)
            else:
                self._settle_layout(first.line, second.line)
            while first.line is not None and second.line is not None:
                if first.line.rank != second.line.rank:
                    # The next line is read, and its order checked, before
                    # this one counts as unpaired: in `join a b` over
                    # `a 1/c 2/b 3` and `a x/z q`, `b 3` follows the first
                    # unpaired line and goes unreported (GNU 9.7).
                    index = 0 if first.line.rank < second.line.rank else 1
                    side = self.sides[index]
                    if side.shown and side.line is not None:
                        self._print_alone(index, side.line)
                    if not self._in_hand(side):
                        async for chunk in self._refill(side):
                            yield chunk
                    self._advance(side)
                    self._lone_seen = True
                else:
                    groups: list[list[_Line]] = []
                    for side in self.sides:
                        head = side.line
                        if head is None:
                            break
                        group = [head]
                        while True:
                            if not self._in_hand(side):
                                async for chunk in self._refill(side):
                                    yield chunk
                            self._advance(side)
                            if (
                                side.line is None
                                or side.line.rank != head.rank
                            ):
                                break
                            group.append(side.line)
                        groups.append(group)
                    # Two groups of n equal keys make n * n lines, so the
                    # output goes on as it fills rather than per group.
                    if self.flags.paired and len(groups) == 2:
                        for one in groups[0]:
                            for other in groups[1]:
                                self._print_pair(one, other)
                                if len(self._out) >= CHUNK:
                                    yield self._take()
                if len(self._out) >= CHUNK:
                    yield self._take()
            # Once the other file has ended no line counts as unpaired:
            # `join a b` over `a 1` and `a x/c y/b z/a w` reports nothing.
            for index, side in enumerate(self.sides):
                while side.line is not None and self._still_reading(index):
                    if side.shown:
                        self._print_alone(index, side.line)
                    if not self._in_hand(side):
                        async for chunk in self._refill(side):
                            yield chunk
                    self._advance(side)
                    if len(self._out) >= CHUNK:
                        yield self._take()
            if self.flags.order is OrderCheck.WARN and any(
                side.reported for side in self.sides
            ):
                self._errors += b"join: input is not in sorted order\n"
        except _Halt:
            pass
        if self._out:
            yield self._take()

    async def _open(self) -> None:
        # GNU opens both files before it reads either: a missing FILE2 is
        # reported over a FILE1 that cannot be read (`join dir missing`).
        # Stdin is already open, so it is never read here: `join dir -`
        # reports the directory without waiting on input.
        unreadable: tuple[_Input, BaseException] | None = None
        for side in self.sides:
            if is_stdin(side.path):
                continue
            try:
                await side.reader.peek()
            except FS_ERRORS as exc:
                if never_opened(side.reader, side.path, exc):
                    self._fail(side, exc)
                unreadable = unreadable or (side, exc)
        if unreadable is not None:
            self._fail(*unreadable)

    def _fail(self, side: _Input, exc: BaseException) -> NoReturn:
        if never_opened(side.reader, side.path, exc):
            line = fs_error_line(CommandName.JOIN, side.path, exc)
        else:
            line = f"join: read error: {fs_strerror(exc) or exc}\n"
        self._errors += encode_text(line)
        self._status = 1
        raise _Halt

    def _still_reading(self, index: int) -> bool:
        # Past the other file's end a line is read only to print it or to
        # look at its order.
        side = self.sides[index]
        order = self.flags.order
        return (
            side.shown
            or order is OrderCheck.FAIL
            or (order is OrderCheck.WARN and not side.reported)
        )

    def _in_hand(self, side: _Input) -> bool:
        """Whether the next record can be taken without waiting for input.

        Only the latest chunk is searched: what ``held`` keeps has no
        terminator in it.

        Args:
            side (_Input): the input.
        """
        side.cut = side.chunk.find(self.flags.terminator, side.start)
        return side.cut >= 0 or side.drained

    async def _refill(self, side: _Input) -> AsyncGenerator[bytes, None]:
        """Read on until a record is in hand, handing on what is printed
        before each read that may wait: under `join -a1 - empty` a line
        reaches a reader before the next one is typed.

        Args:
            side (_Input): the input, with no record in hand.
        """
        while True:
            if self._out:
                yield self._take()
            # The unread tail is kept before the next read, and a chunk that
            # is not bytes (a view of a buffer its source fills again) is
            # copied as it comes, so later reads never change what is kept.
            if side.start < len(side.chunk):
                side.held.append(side.chunk[side.start :])
            side.chunk, side.start = b"", 0
            try:
                chunk = await side.reader.read_chunk()
            except FS_ERRORS as exc:
                self._fail(side, exc)
            if chunk is None:
                side.drained = True
                return
            side.chunk = chunk if isinstance(chunk, bytes) else bytes(chunk)
            if self._in_hand(side):
                return

    def _advance(self, side: _Input) -> None:
        """Take the record ``_in_hand`` found as the input's current one,
        and check its order.

        Args:
            side (_Input): the input.
        """
        if side.cut >= 0:
            tail = side.chunk[side.start : side.cut]
            side.start = side.cut + 1
        elif side.held or side.start < len(side.chunk):
            # The last record, with no terminator after it.
            tail = side.chunk[side.start :]
            side.start = len(side.chunk)
        else:
            side.line = None
            return
        if side.held:
            side.held.append(tail)
            text = b"".join(side.held)
            side.held = []
        else:
            text = tail
        side.cut = -1
        side.count += 1
        line = self._split(side, text)
        if (
            side.last is not None
            and line.rank < side.last
            and self.flags.order is not OrderCheck.OFF
        ):
            self._out_of_order(side, line)
        side.last = line.rank
        side.line = line

    def _out_of_order(self, side: _Input, line: _Line) -> None:
        if self.flags.order is OrderCheck.WARN and (
            side.reported or not self._lone_seen
        ):
            return
        # The line is named up to its first NUL, as GNU 9.7 prints it.
        shown = line.text.split(b"\0", 1)[0]
        self._errors += b"join: %s:%d: is not sorted: %s\n" % (
            side.name,
            side.count,
            shown,
        )
        self._status = 1
        side.reported = True
        if self.flags.order is OrderCheck.FAIL:
            raise _Halt

    def _split(self, side: _Input, text: bytes) -> _Line:
        delimiter = self.flags.delimiter
        if not text:
            fields: list[bytes] = []
        elif delimiter is None:
            fields = self._blanks.findall(text)
        elif delimiter == WHOLE_RECORD:
            fields = [text]
        else:
            fields = text.split(delimiter)
        key = fields[side.key] if side.key < len(fields) else b""
        return _Line(
            text, fields, key, key.upper() if self.flags.fold_case else key
        )

    def _settle_layout(self, left: _Line | None, right: _Line | None) -> None:
        # -o auto takes each file's field count from its first line, the
        # header when there is one; an empty file counts none.
        if self._layout is not None or not self.flags.auto_columns:
            return
        layout = [JOIN_COLUMN]
        for number, line in ((1, left), (2, right)):
            skip = self.flags.keys[number - 1]
            count = len(line.fields) if line is not None else 0
            layout.extend((number, i) for i in range(count) if i != skip)
        self._layout = layout

    def _print_header(self, left: _Line | None, right: _Line | None) -> None:
        if left is not None and right is not None:
            self._print_pair(left, right)
        elif left is not None:
            self._print_alone(0, left)
        elif right is not None:
            self._print_alone(1, right)

    def _print(self, values: list[bytes]) -> None:
        filler = self.flags.filler
        if filler is not None:
            values = [value or filler for value in values]
        self._out += self.flags.separator.join(values)
        self._out += self.flags.terminator

    def _others(self, line: _Line, index: int) -> list[bytes]:
        skip = self.flags.keys[index]
        return [value for i, value in enumerate(line.fields) if i != skip]

    def _pick(
        self,
        column: tuple[int, int],
        lines: tuple[_Line | None, _Line | None],
        key: bytes,
    ) -> bytes:
        number, index = column
        if number == 0:
            return key
        line = lines[number - 1]
        if line is None or index >= len(line.fields):
            return b""
        return line.fields[index]

    def _print_pair(self, left: _Line, right: _Line) -> None:
        # A joined line shows FILE1's spelling of the key, as -i joins
        # `a` with `A`.
        if self._layout is None:
            self._print(
                [left.key, *self._others(left, 0), *self._others(right, 1)]
            )
        else:
            lines = (left, right)
            self._print([self._pick(c, lines, left.key) for c in self._layout])

    def _print_alone(self, index: int, line: _Line) -> None:
        if self._layout is None:
            self._print([line.key, *self._others(line, index)])
        else:
            lines = (line, None) if index == 0 else (None, line)
            self._print([self._pick(c, lines, line.key) for c in self._layout])


def _operand_word(path: PathSpec) -> str:
    return path.raw_path


async def join(
    paths: list[PathSpec],
    *,
    read_stream: PolymorphicReadFn,
    stdin: ByteSource | None = None,
    flags: JoinFlags = JoinFlags(),
) -> tuple[ByteSource | None, IOResult]:
    """GNU ``join`` of two files over already-parsed options.

    Args:
        paths (list[PathSpec]): the operands, of which ``flags.files``
            names the two files; ``-`` reads stdin.
        read_stream (PolymorphicReadFn): reads one operand's bytes.
        stdin (ByteSource | None): the line's input.
        flags (JoinFlags): the options, from ``parse_flags``.
    """
    if len(paths) <= max(flags.files):
        raise missing_operand_error(
            CommandName.JOIN, _operand_word(paths[-1]) if paths else None
        )
    file1, file2 = (paths[index] for index in flags.files)
    if file1.raw_path == "-" and file2.raw_path == "-":
        return None, IOResult(
            exit_code=1, stderr=b"join: both files cannot be standard input\n"
        )
    read = stdin_stream(read_stream, stdin)
    readers = (AsyncLineIterator(read(file1)), AsyncLineIterator(read(file2)))
    merge = _Join(
        flags,
        (encode_text(_operand_word(file1)), encode_text(_operand_word(file2))),
        readers,
        (file1, file2),
    )
    io = IOResult()
    return _join_stream(merge, io), io


async def _join_stream(
    merge: _Join, io: IOResult
) -> AsyncGenerator[bytes, None]:
    try:
        async with aclosing(merge.run()) as source:
            async for chunk in source:
                yield chunk
    finally:
        io.exit_code, io.stderr = merge.outcome()
        for reader in merge.inputs:
            await reader.discard()


async def join_generic(
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    resolve_glob: Callable[[list[PathSpec]], Awaitable[list[PathSpec]]],
    read_stream: PolymorphicReadFn,
) -> tuple[ByteSource | None, IOResult]:
    """The builder's entry point: parse the line's flags, then ``join``.

    Each operand's glob expands on its own, so the option loop sees its
    matches where the word was typed (``join -j1 2 *.txt``).

    Args:
        paths (list[PathSpec]): the operands, unresolved.
        texts (list[str]): unused; join takes no text operands.
        ctx (Context): the line's flags, stdin and words.
        resolve_glob (Callable): expands globs against the backend.
        read_stream (PolymorphicReadFn): reads one operand's bytes.
    """
    groups = [await resolve_glob([path]) for path in paths]
    resolved = [path for group in groups for path in group]
    flags = spread_operands(
        ctx.flags,
        [[_operand_word(path) for path in group] for group in groups],
    )
    return await join(
        resolved,
        read_stream=read_stream,
        stdin=ctx.stdin,
        flags=parse_flags(
            flags, [_operand_word(path) for path in resolved], ctx.argv
        ),
    )


__all__ = ["JoinFlags", "OrderCheck", "join", "join_generic", "parse_flags"]
