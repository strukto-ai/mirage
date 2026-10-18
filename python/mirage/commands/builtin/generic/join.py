import re
from collections.abc import (
    AsyncGenerator,
    Awaitable,
    Callable,
    Mapping,
    Sequence,
)
from dataclasses import dataclass, field
from enum import Enum

from mirage.commands.builtin.utils.lines import record_separator
from mirage.commands.builtin.utils.stream import never_opened, stdin_stream
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
from mirage.io.cooperative import chunks
from mirage.io.types import ByteSource, IOResult
from mirage.io.yield_budget import YieldBudget
from mirage.rs.stream import close_stream, open_stream
from mirage.shell.bytes import byte_view, encode_text
from mirage.types import PathSpec, PolymorphicReadFn

# The largest field number join keeps; GNU 9.7 reads any larger one as
# this one, so `-1 99999999999999999999 -1 1` is refused as
# "incompatible join fields 9223372036854775806, 0".
LARGEST_FIELD = 2**63 - 1
# The -t value that keeps each record whole: both `-t ''` and `-t $'\n'`
# select it, under -z as well, and they never conflict with each other.
WHOLE_RECORD = b"\n"
COLUMN_BREAK = re.compile(r"[, \t]")
JOIN_COLUMN = (0, 0)
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
    file: int
    claimed: bool = False


@dataclass
class _Operand:
    position: int
    word: str
    lone: _LoneJ | None = None
    listed: bool = False


@dataclass
class _Reading:
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
    if reading.seen == 0:
        for word in operands:
            reading.operand(word, None, False)
    return reading.finish(argv)


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
    io = IOResult()
    return _join_stream(flags, readers, (file1, file2), io), io


async def _reader_chunks(
    reader: AsyncLineIterator,
) -> AsyncGenerator[bytes, None]:
    while (chunk := await reader.read_chunk()) is not None:
        yield chunk


async def _join_stderr(
    pieces: list[bytes], count: int
) -> AsyncGenerator[bytes, None]:
    for index in range(count):
        yield pieces[index]


async def _join_stream(
    flags: JoinFlags,
    readers: tuple[AsyncLineIterator, AsyncLineIterator],
    paths: tuple[PathSpec, PathSpec],
    io: IOResult,
) -> AsyncGenerator[bytes, None]:
    stream = open_stream(
        "join",
        {
            "keys": list(flags.keys),
            "unpaired": list(flags.unpaired),
            "paired": flags.paired,
            "filler": byte_view(flags.filler)
            if flags.filler is not None
            else None,
            "columns": [list(column) for column in flags.columns],
            "auto_columns": flags.auto_columns,
            "delimiter": byte_view(flags.delimiter)
            if flags.delimiter is not None
            else None,
            "separator": byte_view(flags.separator),
            "fold_case": flags.fold_case,
            "terminator": flags.terminator[0],
            "order": flags.order.value,
            "header": flags.header,
            "names": [byte_view(path.raw_path) for path in paths],
        },
    )
    sources = [chunks(_reader_chunks(reader)) for reader in readers]
    budget = YieldBudget()
    errors: list[bytes] = []
    io.stderr = b""

    def record_result() -> None:
        if error := stream.take_stderr():
            errors.append(error)
            io.stderr = _join_stderr(errors, len(errors))
        io.exit_code = max(io.exit_code, stream.status())

    def fail(which: int, exc: BaseException) -> None:
        errors.append(
            encode_text(
                fs_error_line(CommandName.JOIN, paths[which], exc)
                if never_opened(readers[which], paths[which], exc)
                else f"join: read error: {fs_strerror(exc) or exc}\n"
            )
        )
        io.stderr, io.exit_code = _join_stderr(errors, len(errors)), 1

    try:
        unreadable: tuple[int, BaseException] | None = None
        for which, reader in enumerate(readers):
            try:
                await reader.peek()
            except FS_ERRORS as exc:
                if never_opened(reader, paths[which], exc):
                    fail(which, exc)
                    return
                unreadable = unreadable or (which, exc)
        if unreadable is not None:
            fail(*unreadable)
            return
        while True:
            await budget.run()
            if stream.busy():
                output = stream.drain()
            elif (requested := stream.wants()) is not None:
                try:
                    chunk = await anext(sources[requested])
                except StopAsyncIteration:
                    output = stream.end_input(requested)
                except FS_ERRORS as exc:
                    fail(requested, exc)
                    return
                else:
                    output = stream.feed_input(requested, chunk)
            else:
                break
            record_result()
            if output:
                yield output
    finally:
        record_result()
        await close_stream(stream)
        for source in sources:
            await source.aclose()
        for reader in readers:
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
