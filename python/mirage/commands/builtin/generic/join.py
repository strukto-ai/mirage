import re
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from enum import Enum

from mirage.commands.builtin.utils.stream import stdin_bytes
from mirage.commands.config import CommandOpts
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
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

IDX_MAX = 2**63 - 1
INTMAX_MIN = -(2**63)
WHOLE_LINE = b"\n"
FIELD_RUN = re.compile(rb"[^ \t\n]+")
INTEGER = re.compile(r"[ \t\n\v\f\r]*([+-]?[0-9]+)", re.ASCII)
OUTLIST_SEPARATOR = re.compile(r"[, \t]")
ASCII_UPPER = bytes.maketrans(
    b"abcdefghijklmnopqrstuvwxyz", b"ABCDEFGHIJKLMNOPQRSTUVWXYZ"
)
OPTIONS = (
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


class CheckOrder(Enum):
    """join.c's ``check_input_order``: whether disorder is diagnosed."""

    DEFAULT = "default"
    ENABLED = "enabled"
    DISABLED = "disabled"


@dataclass(frozen=True, slots=True)
class JoinFlags:
    """join's options once GNU's option loop has run, in join.c's terms.

    Args:
        field1 (int): zero-based join field of file 1.
        field2 (int): zero-based join field of file 2.
        tab (bytes | None): the field separator byte, None for runs of
            blanks, or ``WHOLE_LINE`` when the whole line is the field.
        output_separator (bytes): what goes between output fields.
        unpairables1 (bool): print file 1's unpairable lines (-a1, -v1).
        unpairables2 (bool): print file 2's unpairable lines (-a2, -v2).
        pairables (bool): print joined lines (no -v).
        empty_filler (bytes | None): -e, for a missing or empty field.
        outlist (tuple[tuple[int, int], ...]): -o as (file, field) pairs,
            file 0 naming the join field.
        autoformat (bool): -o auto.
        ignore_case (bool): -i.
        eol (bytes): the record terminator, NUL under -z.
        check_order (CheckOrder): --check-order and --nocheck-order.
        header (bool): --header.
        files (tuple[int, int]): which operands are FILE1 and FILE2, since
            the obsolete ``-j1 FIELD``, ``-j2 FIELD`` and ``-o LIST...``
            forms take operands as option values.
    """

    field1: int = 0
    field2: int = 0
    tab: bytes | None = None
    output_separator: bytes = b" "
    unpairables1: bool = False
    unpairables2: bool = False
    pairables: bool = True
    empty_filler: bytes | None = None
    outlist: tuple[tuple[int, int], ...] = ()
    autoformat: bool = False
    ignore_case: bool = False
    eol: bytes = b"\n"
    check_order: CheckOrder = CheckOrder.DEFAULT
    header: bool = False
    files: tuple[int, int] = (0, 1)


class _Status(Enum):
    """join.c's operand_status: what a filed operand may turn out to be."""

    MUST_BE_OPERAND = "operand"
    MIGHT_BE_J1_ARG = "j1"
    MIGHT_BE_J2_ARG = "j2"
    MIGHT_BE_O_ARG = "o"


@dataclass(frozen=True, slots=True)
class _Filed:
    index: int
    word: str
    status: _Status


def _raw(text: str) -> bytes:
    return text.encode("utf-8", "surrogateescape")


def _strtoimax(text: str) -> int | None:
    """``xstrtoimax`` with no valid suffix: the value, or None if invalid.

    Args:
        text (str): the option argument.
    """
    match = INTEGER.fullmatch(text)
    if match is None:
        return None
    return int(match[1])


def _join_field(text: str) -> int:
    """join.c's ``string_to_join_field``: a 1-based field, made 0-based.

    Args:
        text (str): the option argument.
    """
    value = _strtoimax(text)
    if value is not None and not INTMAX_MIN <= value <= IDX_MAX:
        value = IDX_MAX
    if value is None or value <= 0:
        raise UsageError(
            f"join: invalid field number: '{quote_text(text)}'", 1
        )
    return value - 1


def _file_number(text: str) -> int:
    """The FILENUM of ``-a`` or ``-v``: 1 or 2.

    Args:
        text (str): the option argument.
    """
    value = _strtoimax(text)
    if value is None or value not in (1, 2):
        raise UsageError(f"join: invalid file number: '{quote_text(text)}'", 1)
    return value


def _field_spec(spec: str) -> tuple[int, int]:
    """join.c's ``decode_field_spec``: one ``-o`` item as (file, field).

    Args:
        spec (str): ``0``, ``1.N`` or ``2.N``.
    """
    head = spec[:1]
    if head == "0":
        if len(spec) > 1:
            raise UsageError(
                f"join: invalid field specifier: '{quote_text(spec)}'", 1
            )
        return 0, 0
    if head in ("1", "2"):
        if spec[1:2] != ".":
            raise UsageError(
                f"join: invalid field specifier: '{quote_text(spec)}'", 1
            )
        return int(head), _join_field(spec[2:])
    raise UsageError(
        f"join: invalid file number in field spec: '{quote_text(spec)}'", 1
    )


def _field_list(text: str) -> list[tuple[int, int]]:
    """join.c's ``add_field_list``: items split at a comma or blank.

    A separator that ends the list closes it, which is why ``-o 1.1,``
    is accepted while ``-o 1.1,,2.1`` names an empty item.

    Args:
        text (str): the ``-o`` argument.
    """
    specs: list[tuple[int, int]] = []
    rest = text
    while True:
        match = OUTLIST_SEPARATOR.search(rest)
        item = rest if match is None else rest[: match.start()]
        specs.append(_field_spec(item))
        if match is None or match.end() == len(rest):
            return specs
        rest = rest[match.end() :]


def _set_join_field(current: int | None, value: int) -> int:
    if current is not None and current != value:
        raise UsageError(
            f"join: incompatible join fields {current}, {value}", 1
        )
    return value


@dataclass(slots=True)
class _Options:
    """The state join.c's option loop builds, before it is frozen."""

    field1: int | None = None
    field2: int | None = None
    tab: bytes | None = None
    literal_tab: bool = False
    unpairables: list[bool] = field(default_factory=lambda: [False, False])
    pairables: bool = True
    empty_filler: bytes | None = None
    outlist: list[tuple[int, int]] = field(default_factory=list)
    autoformat: bool = False
    ignore_case: bool = False
    zero: bool = False
    check_order: CheckOrder = CheckOrder.DEFAULT
    header: bool = False
    files: list[_Filed] = field(default_factory=list)
    joption_count: list[int] = field(default_factory=lambda: [0, 0])

    def set_tab(self, text: str) -> None:
        raw = _raw(text)
        tab = raw or WHOLE_LINE
        if len(raw) > 1:
            if raw != b"\\0":
                raise UsageError(
                    f"join: multi-character tab '{quote_text(text)}'", 1
                )
            tab = b"\0"
        if self.tab is not None and self.tab != tab:
            raise UsageError("join: incompatible tabs", 1)
        self.tab = tab
        self.literal_tab = self.literal_tab or bool(raw)

    def apply(self, name: str, value: FlagValue, spelled: bool) -> _Status:
        """Take one option, and say what the next operand may be.

        Args:
            name (str): the option's dest.
            value (FlagValue): its value.
            spelled (bool): whether it was typed as a lone ``-j1`` or
                ``-j2`` (SPELLED_WORDS).
        """
        text = value if isinstance(value, str) else ""
        if name == "j" and spelled:
            is_j2 = text == "2"
            self.joption_count[is_j2] += 1
            return (
                _Status.MIGHT_BE_J2_ARG if is_j2 else _Status.MIGHT_BE_J1_ARG
            )
        if name == "o" and text != "auto":
            self.outlist.extend(_field_list(text))
            return _Status.MIGHT_BE_O_ARG
        if name in ("a", "v"):
            if name == "v":
                self.pairables = False
            self.unpairables[_file_number(text) - 1] = True
        elif name == "e":
            raw = _raw(text)
            if self.empty_filler is not None and self.empty_filler != raw:
                raise UsageError(
                    "join: conflicting empty-field replacement strings", 1
                )
            self.empty_filler = raw
        elif name == "args_1":
            self.field1 = _set_join_field(self.field1, _join_field(text))
        elif name == "2":
            self.field2 = _set_join_field(self.field2, _join_field(text))
        elif name == "j":
            self.field1 = _set_join_field(self.field1, _join_field(text))
            self.field2 = _set_join_field(self.field2, self.field1)
        elif name == "o":
            self.autoformat = True
        elif name == "t":
            self.set_tab(text)
        elif name == "ignore_case":
            self.ignore_case = True
        elif name == "zero_terminated":
            self.zero = True
        elif name == "check_order":
            self.check_order = CheckOrder.ENABLED
        elif name == "nocheck_order":
            self.check_order = CheckOrder.DISABLED
        elif name == "header":
            self.header = True
        return _Status.MUST_BE_OPERAND

    def add_file(self, index: int, word: str, status: _Status) -> _Status:
        """join.c's add_file_name: file an operand, taking an earlier one
        as an option's value when a third arrives, and say what the next
        operand may be.

        Args:
            index (int): the operand's position among the operands.
            word (str): the operand as typed.
            status (_Status): what the option before it says it may be.
        """
        if len(self.files) == 2:
            op0 = self.files[0].status is _Status.MUST_BE_OPERAND
            taken = self.files[op0]
            if taken.status is _Status.MUST_BE_OPERAND:
                raise extra_operand_error(CommandName.JOIN, word)
            if taken.status is _Status.MIGHT_BE_J1_ARG:
                self.joption_count[0] -= 1
                self.field1 = _set_join_field(
                    self.field1, _join_field(taken.word)
                )
            elif taken.status is _Status.MIGHT_BE_J2_ARG:
                self.joption_count[1] -= 1
                self.field2 = _set_join_field(
                    self.field2, _join_field(taken.word)
                )
            else:
                self.outlist.extend(_field_list(taken.word))
            del self.files[op0]
        self.files.append(_Filed(index, word, status))
        if status is _Status.MIGHT_BE_O_ARG:
            return _Status.MIGHT_BE_O_ARG
        return _Status.MUST_BE_OPERAND

    def settle_j(self) -> None:
        """A ``-j1`` or ``-j2`` no operand was taken for is ``-j 1`` or
        ``-j 2``."""
        for which in (0, 1):
            if self.joption_count[which]:
                self.field1 = _set_join_field(self.field1, which)
                self.field2 = _set_join_field(self.field2, which)

    def freeze(self) -> JoinFlags:
        separator = (
            self.tab
            if self.tab is not None
            and (self.tab != WHOLE_LINE or self.literal_tab)
            else b" "
        )
        return JoinFlags(
            field1=self.field1 or 0,
            field2=self.field2 or 0,
            tab=self.tab,
            output_separator=separator,
            unpairables1=self.unpairables[0],
            unpairables2=self.unpairables[1],
            pairables=self.pairables,
            empty_filler=self.empty_filler,
            outlist=tuple(self.outlist),
            autoformat=self.autoformat,
            ignore_case=self.ignore_case,
            eol=b"\0" if self.zero else b"\n",
            check_order=self.check_order,
            header=self.header,
            files=(
                (self.files[0].index, self.files[1].index)
                if len(self.files) == 2
                else (0, 1)
            ),
        )


def parse_flags(
    flags: Mapping[str, FlagValue],
    operands: Sequence[str] | None = None,
    argv: Sequence[str] = (),
) -> JoinFlags:
    """Run join.c's option loop over the occurrences in typed order.

    Each option takes effect where it was typed, so ``-a1 -a2`` asks for
    both files, the later of ``--check-order`` and ``--nocheck-order``
    wins, and a second ``-1``, ``-t`` or ``-e`` that disagrees with the
    first is GNU's refusal. The operands are read there too, as join's
    RETURN_IN_ORDER getopt hands them over: a third one is refused where
    it stands, or turns an earlier one into the value of an obsolete
    ``-j1 FIELD``, ``-j2 FIELD`` or ``-o LIST...``. A glob's matches
    stand where it was typed once ``spread_operands`` has put them on the
    tape. Operands the tape does not place, from a call that never went
    through the shell, follow the options, as after ``--``.

    Args:
        flags (Mapping[str, FlagValue]): flags parsed against join's spec.
        operands (Sequence[str] | None): the operands, or None to read the
            options alone.
        argv (Sequence[str]): the line's words, for the usage error.
    """
    options = _Options()
    words = list(operands or ())
    tape = FlagView(flags, spec=SPECS["join"]).occurrences(
        *OPTIONS, OPERAND, SPELLED
    )
    placed = [value for name, value in tape if name == OPERAND]
    if len(placed) != len(words):
        tape = [(name, value) for name, value in tape if name != OPERAND]
    status = _Status.MUST_BE_OPERAND
    spelled = after_dashes = False
    index = 0
    for name, value in tape:
        if name == SPELLED:
            after_dashes = after_dashes or value == "--"
            spelled = value != "--"
        elif name == OPERAND:
            if after_dashes:
                options.add_file(index, words[index], _Status.MUST_BE_OPERAND)
            else:
                status = options.add_file(index, words[index], status)
            index += 1
        else:
            status = options.apply(name, value, spelled)
            spelled = False
    for rest in range(index, len(words)):
        options.add_file(rest, words[rest], _Status.MUST_BE_OPERAND)
    if operands is not None and len(options.files) < 2:
        raise missing_operand_error(
            CommandName.JOIN,
            options.files[-1].word if options.files else None,
            argv,
        )
    options.settle_j()
    return options.freeze()


@dataclass(frozen=True, slots=True)
class _Line:
    record: bytes
    fields: tuple[bytes, ...]
    key: bytes


BLANK = _Line(b"", (), b"")


def _fields(record: bytes, tab: bytes | None) -> tuple[bytes, ...]:
    if not record:
        return ()
    if tab is None:
        return tuple(FIELD_RUN.findall(record))
    if tab == WHOLE_LINE:
        return (record,)
    return tuple(record.split(tab))


def _keycmp(left: bytes, right: bytes) -> int:
    if not left:
        return 0 if not right else -1
    if not right:
        return 1
    return (left > right) - (left < right)


def _records(data: bytes, eol: bytes) -> list[bytes]:
    records = data.split(eol)
    if records[-1] == b"":
        records.pop()
    return records


class _Merge:
    """join.c's ``join``: a merge of two inputs read one line at a time.

    Disorder is diagnosed as each line is read, against the previous line
    of the same file: always under --check-order, which stops the run
    where it stands, and by default only once an unpairable line has been
    seen, once per file. Both are why the order check is read-driven
    rather than a property of the whole input.

    Args:
        flags (JoinFlags): the parsed options.
        names (tuple[bytes, bytes]): each operand as typed.
        inputs (tuple[list[bytes], list[bytes]]): each file's records.
    """

    def __init__(
        self,
        flags: JoinFlags,
        names: tuple[bytes, bytes],
        inputs: tuple[list[bytes], list[bytes]],
    ) -> None:
        self.flags = flags
        self.names = names
        self.inputs = inputs
        self.fields = (flags.field1, flags.field2)
        self.read = [0, 0]
        self.previous: list[_Line | None] = [None, None]
        self.warned = [False, False]
        self.seen_unpairable = False
        self.fatal = False
        self.autocount = [0, 0]
        self.out: list[bytes] = []
        self.err: list[bytes] = []

    def get_line(self, which: int) -> _Line | None:
        if self.fatal or self.read[which] == len(self.inputs[which]):
            return None
        record = self.inputs[which][self.read[which]]
        self.read[which] += 1
        fields = _fields(record, self.flags.tab)
        index = self.fields[which]
        key = fields[index] if index < len(fields) else b""
        line = _Line(
            record,
            fields,
            key.translate(ASCII_UPPER) if self.flags.ignore_case else key,
        )
        previous = self.previous[which]
        self.previous[which] = line
        if previous is not None and self.check_order(previous, line, which):
            return None
        return line

    def check_order(self, previous: _Line, line: _Line, which: int) -> bool:
        """Diagnose LINE against PREVIOUS; whether the run stops here.

        Args:
            previous (_Line): the line read before it from the same file.
            line (_Line): the line just read.
            which (int): 0 for file 1, 1 for file 2.
        """
        mode = self.flags.check_order
        if mode is CheckOrder.DISABLED or self.warned[which]:
            return False
        if mode is CheckOrder.DEFAULT and not self.seen_unpairable:
            return False
        if _keycmp(previous.key, line.key) <= 0:
            return False
        text = line.record.split(b"\0", 1)[0]
        self.err.append(
            b"join: "
            + self.names[which]
            + b":"
            + str(self.read[which]).encode()
            + b": is not sorted: "
            + text
            + b"\n"
        )
        if mode is CheckOrder.ENABLED:
            self.fatal = True
        else:
            self.warned[which] = True
        return self.fatal

    def prfield(self, index: int, line: _Line) -> bytes:
        value = line.fields[index] if index < len(line.fields) else b""
        if value or self.flags.empty_filler is None:
            return value
        return self.flags.empty_filler

    def prfields(self, line: _Line, which: int) -> list[bytes]:
        count = (
            self.autocount[which]
            if self.flags.autoformat
            else len(line.fields)
        )
        return [
            self.prfield(i, line)
            for i in range(count)
            if i != self.fields[which]
        ]

    def emit(self, line1: _Line, line2: _Line) -> None:
        if self.fatal:
            return
        lines = (line1, line2)
        if line1 is BLANK:
            key = self.prfield(self.fields[1], line2)
        else:
            key = self.prfield(self.fields[0], line1)
        if self.flags.outlist:
            parts = [
                self.prfield(index, lines[file - 1]) if file else key
                for file, index in self.flags.outlist
            ]
        else:
            parts = [key, *self.prfields(line1, 0), *self.prfields(line2, 1)]
        self.out.append(
            self.flags.output_separator.join(parts) + self.flags.eol
        )

    def first(self, which: int) -> list[_Line]:
        line = self.get_line(which)
        return [] if line is None else [line]

    def run_of(self, which: int, run: list[_Line], other: _Line) -> bool:
        """Read file WHICH while it matches OTHER; whether it hit EOF.

        Args:
            which (int): 0 for file 1, 1 for file 2.
            run (list[_Line]): the lines read so far, extended in place.
            other (_Line): the other file's current line.
        """
        while True:
            line = self.get_line(which)
            if line is None:
                return True
            run.append(line)
            if _keycmp(line.key, other.key) != 0:
                return False

    def tail(self, which: int, run: list[_Line]) -> None:
        """Finish the file left over once the other one ended.

        Its lines are unpairable, printed under -a or -v, and still read
        for the order check unless --nocheck-order, though they never
        count as unpairable for the default check themselves.

        Args:
            which (int): 0 for file 1, 1 for file 2.
            run (list[_Line]): the file's current line, or nothing.
        """
        unpairables = (self.flags.unpairables1, self.flags.unpairables2)[which]
        checktail = (
            self.flags.check_order is not CheckOrder.DISABLED
            and not all(self.warned)
        )
        if not run or not (unpairables or checktail):
            return
        line: _Line | None = run[0]
        while line is not None:
            if unpairables:
                self.emit(*((line, BLANK) if which == 0 else (BLANK, line)))
            line = (
                None
                if self.warned[which] and not unpairables
                else self.get_line(which)
            )

    def run(self) -> None:
        seq1 = self.first(0)
        seq2 = self.first(1)
        if self.flags.autoformat:
            self.autocount = [
                len(seq[0].fields) if seq else 0 for seq in (seq1, seq2)
            ]
        if self.flags.header and (seq1 or seq2):
            self.emit(seq1[0] if seq1 else BLANK, seq2[0] if seq2 else BLANK)
            self.previous = [None, None]
            seq1 = self.first(0) if seq1 else seq1
            seq2 = self.first(1) if seq2 else seq2
        while seq1 and seq2:
            diff = _keycmp(seq1[0].key, seq2[0].key)
            if diff < 0:
                if self.flags.unpairables1:
                    self.emit(seq1[0], BLANK)
                seq1 = self.first(0)
                self.seen_unpairable = True
                continue
            if diff > 0:
                if self.flags.unpairables2:
                    self.emit(BLANK, seq2[0])
                seq2 = self.first(1)
                self.seen_unpairable = True
                continue
            eof1 = self.run_of(0, seq1, seq2[0])
            eof2 = self.run_of(1, seq2, seq1[0])
            if self.flags.pairables:
                for line1 in seq1 if eof1 else seq1[:-1]:
                    for line2 in seq2 if eof2 else seq2[:-1]:
                        self.emit(line1, line2)
            seq1 = [] if eof1 else seq1[-1:]
            seq2 = [] if eof2 else seq2[-1:]
        self.tail(0, seq1)
        self.tail(1, seq2)

    def result(self) -> tuple[bytes, IOResult]:
        stderr = b"".join(self.err)
        if not self.fatal and any(self.warned):
            stderr += b"join: input is not in sorted order\n"
        return b"".join(self.out), IOResult(
            stderr=stderr or None, exit_code=1 if stderr else 0
        )


def _operand_word(path: PathSpec) -> str:
    return path.raw_path or path.virtual


async def join(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    stdin: ByteSource | None = None,
    flags: JoinFlags = JoinFlags(),
) -> tuple[ByteSource | None, IOResult]:
    """GNU ``join`` of two files over already-parsed options.

    Args:
        paths (list[PathSpec]): the operands, of which ``flags.files``
            names the two files; ``-`` reads stdin.
        read_bytes (Callable): reads one operand's bytes.
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
    read = stdin_bytes(read_bytes, stdin)
    data1 = await read(file1)
    data2 = await read(file2)
    merge = _Merge(
        flags,
        (_raw(_operand_word(file1)), _raw(_operand_word(file2))),
        (_records(data1, flags.eol), _records(data2, flags.eol)),
    )
    merge.run()
    return merge.result()


async def join_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    resolve_glob: Callable[[list[PathSpec]], Awaitable[list[PathSpec]]],
    read_bytes: Callable[..., Awaitable[bytes]],
) -> tuple[ByteSource | None, IOResult]:
    """The builder's entry point: parse the line's flags, then ``join``.

    Each operand's glob expands on its own, so the option loop sees its
    matches where the word was typed (``join -j1 2 *.txt``).

    Args:
        paths (list[PathSpec]): the operands, unresolved.
        texts (list[str]): unused; join takes no text operands.
        opts (CommandOpts): the line's flags, stdin and words.
        resolve_glob (Callable): expands globs against the backend.
        read_bytes (Callable): reads one operand's bytes.
    """
    groups = [await resolve_glob([path]) for path in paths]
    resolved = [path for group in groups for path in group]
    flags = spread_operands(
        opts.flags,
        [[_operand_word(path) for path in group] for group in groups],
    )
    return await join(
        resolved,
        read_bytes=read_bytes,
        stdin=opts.stdin,
        flags=parse_flags(
            flags, [_operand_word(path) for path in resolved], opts.argv
        ),
    )


__all__ = ["JoinFlags", "join", "join_generic", "parse_flags"]
