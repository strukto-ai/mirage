import inspect
from collections.abc import AsyncIterator, Awaitable, Mapping
from contextlib import aclosing
from dataclasses import dataclass
from typing import Any, Callable

from mirage.commands.builtin.utils.files0 import listed_names
from mirage.commands.builtin.utils.operands import at_offsets
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.builtin.utils.stream import (
    is_stdin,
    resolve_source,
    stdin_stream,
)
from mirage.commands.config import Context
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.commands.spec.usage import usage_hint, word_refusal_error
from mirage.commands.spec.word_choice import WordMatch, match_word
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import fs_strerror
from mirage.errors.render import ZERO_LENGTH_NAME, fs_error_line
from mirage.io.types import ByteSource, IOResult, PathRecord
from mirage.rs import run_stream
from mirage.rs.stream import open_stream
from mirage.shell.bytes import byte_view, decode_text, encode_text
from mirage.types import JsonValue, PathSpec, PolymorphicReadFn
from mirage.utils.quote import shell_quote, shell_quote_always

# The --total words in GNU's order, which is both the accepted set and
# what `--total=x` lists back. No aliases, so one per line.
TOTAL_ARGS = ("auto", "always", "only", "never")


@dataclass(frozen=True, slots=True)
class WCFlags:
    lines: bool = False
    words: bool = False
    bytes_: bool = False
    chars: bool = False
    max_line_length: bool = False
    total: str = "auto"
    files0_from: PathSpec | None = None


def parse_flags(flags: Mapping[str, FlagValue]) -> WCFlags:
    fl = FlagView(flags, spec=SPECS["wc"])
    raw_total = fl.as_str("total")
    # `--total=` is NOT the default: GNU reads the empty word as a prefix
    # of every candidate and answers `ambiguous argument ''` (exit 1).
    # The old `or "auto"` took it as `auto` and exited 0, which was also
    # the one py/ts split here -- TypeScript refused it.
    word = "auto" if raw_total is None else raw_total
    match = match_word(word, TOTAL_ARGS)
    if not isinstance(match, WordMatch):
        raise word_refusal_error(
            "wc", "--total", word, TOTAL_ARGS, None, match.kind
        )
    total = match.word
    return WCFlags(
        lines=fl.as_bool("lines"),
        words=fl.as_bool("words"),
        bytes_=fl.as_bool("bytes"),
        chars=fl.as_bool("chars"),
        max_line_length=fl.as_bool("max_line_length"),
        total=total,
        files0_from=fl.as_path("files0_from"),
    )


@dataclass
class WCCounts:
    lines: int = 0
    words: int = 0
    bytes_: int = 0
    chars: int = 0
    max_line_length: int = 0

    def merge(self, other: "WCCounts") -> None:
        self.lines += other.lines
        self.words += other.words
        self.bytes_ += other.bytes_
        self.chars += other.chars
        if other.max_line_length > self.max_line_length:
            self.max_line_length = other.max_line_length


async def wc(
    src: bytes | AsyncIterator[bytes], *, flags: WCFlags | None = None
) -> WCCounts:
    """GNU wc's counts of *src*, streamed through mirage-rs.

    Only ``-l`` and ``-c`` count without decoding; any other count decodes
    UTF-8, and a byte that decodes to no character is part of a word but
    no character and no column.

    Args:
        src (bytes | AsyncIterator[bytes]): The input.
        flags (WCFlags | None): The counts asked for; None counts all.
    """
    asked = flags or WCFlags()
    config: dict[str, JsonValue] = {
        "lines": asked.lines,
        "words": asked.words,
        "bytes": asked.bytes_,
        "chars": asked.chars,
        "max_line_length": asked.max_line_length,
    }
    async with aclosing(run_stream("wc", config, src)) as parts:
        report = b"".join([part async for part in parts])
    lines, words, bytes_count, chars, max_len = (
        int(value) for value in report.split()
    )
    return WCCounts(
        lines=lines,
        words=words,
        bytes_=bytes_count,
        chars=chars,
        max_line_length=max_len,
    )


def _selected_values(
    counts: WCCounts,
    *,
    lines: bool = False,
    words: bool = False,
    bytes_: bool = False,
    chars: bool = False,
    max_line_length: bool = False,
) -> list[int]:
    selected = lines or words or bytes_ or chars or max_line_length
    if not selected:
        return [counts.lines, counts.words, counts.bytes_]
    values: list[int] = []
    if lines:
        values.append(counts.lines)
    if words:
        values.append(counts.words)
    if chars:
        values.append(counts.chars)
    if bytes_:
        values.append(counts.bytes_)
    if max_line_length:
        values.append(counts.max_line_length)
    return values


def number_width(sizes: list[int | None], operands: int, counts: int) -> int:
    """GNU wc's column width, which it takes from the operands.

    One operand, or stdin, shown with one count prints unpadded. Otherwise
    the width is the digits of the regular files' total size, and at least
    7 once any operand is a stream or a directory, whose size GNU cannot
    know (coreutils 9.7). A redirected file reaches mirage as a stream, so
    ``wc < file`` pads to 7 where GNU pads to the file's size.

    Args:
        sizes (list[int | None]): per operand that opened, a regular
            file's size, or None for a stream or a directory.
        operands (int): the operands given, 1 for stdin.
        counts (int): the columns each row shows.
    """
    if operands <= 1 and counts == 1:
        return 1
    width = len(str(sum(size for size in sizes if size is not None)))
    return max(width, 7) if None in sizes else width


def format_wc_lines(
    rows: list[tuple[WCCounts, str | None]],
    *,
    lines: bool = False,
    words: bool = False,
    bytes_: bool = False,
    chars: bool = False,
    max_line_length: bool = False,
    width: int | None = None,
) -> list[str]:
    engine = open_stream(
        "wc",
        {
            "report": [
                {
                    "values": [
                        value
                        for value in _selected_values(
                            counts,
                            lines=lines,
                            words=words,
                            bytes_=bytes_,
                            chars=chars,
                            max_line_length=max_line_length,
                        )
                    ],
                    "label": None if label is None else byte_view(label),
                }
                for counts, label in rows
            ],
            "width": width,
        },
    )
    output = [engine.finish()]
    while engine.busy():
        output.append(engine.drain())
    return decode_text(b"".join(output)).split("\n")[:-1]


def format_count_rows(
    rows: list[tuple[WCCounts, str | None]],
    totals: WCCounts,
    operand_count: int,
    flags: WCFlags,
    width: int | None = None,
) -> bytes:
    return format_records(
        count_lines(rows, totals, operand_count, flags, width)
    )


def count_lines(
    rows: list[tuple[WCCounts, str | None]],
    totals: WCCounts,
    operand_count: int,
    flags: WCFlags,
    width: int | None = None,
) -> list[str]:
    """The lines ``format_count_rows`` prints, one per row and the
    total, without terminators.

    Args:
        rows (list[tuple[WCCounts, str | None]]): each row and its name.
        totals (WCCounts): the summed counts.
        operand_count (int): how many operands the line named.
        flags (WCFlags): the parsed flags.
        width (int | None): the column width, None for the printed one.
    """
    if flags.total == "only":
        values = _selected_values(
            totals,
            lines=flags.lines,
            words=flags.words,
            bytes_=flags.bytes_,
            chars=flags.chars,
            max_line_length=flags.max_line_length,
        )
        return [" ".join(str(value) for value in values)]
    output_rows = list(rows)
    include_total = flags.total == "always" or (
        flags.total == "auto" and operand_count > 1
    )
    if include_total:
        output_rows.append((totals, "total"))
    return format_wc_lines(
        output_rows,
        lines=flags.lines,
        words=flags.words,
        bytes_=flags.bytes_,
        chars=flags.chars,
        max_line_length=flags.max_line_length,
        width=width,
    )


def shown_counts(flags: WCFlags) -> int:
    """How many columns a row shows under these flags.

    Args:
        flags (WCFlags): The parsed flags.
    """
    return len(
        _selected_values(
            WCCounts(),
            lines=flags.lines,
            words=flags.words,
            bytes_=flags.bytes_,
            chars=flags.chars,
            max_line_length=flags.max_line_length,
        )
    )


async def format_multi(
    paths: list[PathSpec],
    *,
    read: Callable[..., Any],
    lines: bool = False,
    words: bool = False,
    bytes_: bool = False,
    chars: bool = False,
    max_line_length: bool = False,
    total: str = "auto",
    line_count: Callable[[PathSpec], Awaitable[int | None]] | None = None,
    size_of: Callable[[PathSpec], Awaitable[int | None]] | None = None,
    listed_from: str | None = None,
) -> tuple[bytes, list[tuple[int, bytes]], list[PathRecord]]:
    """Format wc output for multiple already-resolved paths.

    Globs are expanded by the caller (``resolve_glob``) before this runs, so
    ``paths`` is always a flat list of concrete entries, never patterns. One
    record is emitted per path, plus a trailing ``total`` row when more than
    one path is given; every record ends with a newline per POSIX wc. A
    failed operand is skipped and reported as one GNU stderr line, and the
    ``total`` row still prints (GNU wc totals the operands that resolved,
    ``0 total`` when none did). Lines counted alone are asked of
    ``line_count`` first, so a mount that can count a file's lines on
    its own (a ``COUNT(*)`` on a table) does not send it; a row counted
    that way has no byte size, so the columns are as wide as the
    printed numbers. Bytes counted alone are asked of ``size_of``
    first, as GNU takes a regular file's size from its stat.

    Args:
        paths (list[PathSpec]): Resolved paths; only ``.virtual`` is read.
        read (Callable[..., Any]): Reader called as ``read(path)``;
            returns bytes, an awaitable of bytes, or an async byte iterator.
        line_count (Callable[[PathSpec], Awaitable[int | None]] | None):
            the mount's ``line_count`` called as ``line_count(path)``;
            None, or an answer of None, reads the file.
        size_of (Callable[[PathSpec], Awaitable[int | None]] | None):
            a regular file's size, called as ``size_of(path)``; None, or
            an answer of None, reads the file.
        listed_from (str | None): the ``--files0-from`` list the paths
            were read from, as typed (``-`` for stdin), which names an
            empty entry by its number and pads nothing when it is stdin.

    Returns:
        tuple[bytes, list[tuple[int, bytes]], list[PathRecord]]: Encoded
        wc output (``b""`` when nothing prints), the stderr line of each
        failed operand with the offset in the output it goes before, as
        GNU reports one and goes on (``at_offsets``), and each printed
        row's counts.
    """
    flags = WCFlags(
        lines=lines,
        words=words,
        bytes_=bytes_,
        chars=chars,
        max_line_length=max_line_length,
        total=total,
    )
    rows: list[tuple[WCCounts, str | None]] = []
    named: list[tuple[PathSpec, int]] = []
    sizes: list[int | None] = []
    totals = WCCounts()
    notes: list[tuple[int, bytes]] = []
    counted = (
        line_count
        if lines
        and not (words or bytes_ or chars or max_line_length)
        and line_count is not None
        else None
    )
    sized = (
        size_of
        if bytes_
        and not (lines or words or chars or max_line_length)
        and size_of is not None
        else None
    )
    pushed = False
    for run, path in enumerate(paths):
        if listed_from is not None:
            refusal = _listed_refusal(listed_from, path, run)
            if refusal:
                notes.append((len(rows), encode_text(refusal)))
                continue
        try:
            found = (
                await counted(path)
                if counted is not None and not is_stdin(path)
                else None
            )
            size = (
                await sized(path)
                if sized is not None and not is_stdin(path)
                else None
            )
            if found is not None:
                counts = WCCounts(lines=found)
                pushed = True
            elif size is not None:
                counts = WCCounts(bytes_=size)
            else:
                source = read(path)
                if inspect.isawaitable(source):
                    source = await source
                counts = await wc(source, flags=flags)
        except IsADirectoryError as exc:
            # GNU opens a directory and fails only to read it, so it prints
            # a row of zeros, then the error, and pads as for a stream.
            rows.append((WCCounts(), path.raw_path))
            named.append((path, run))
            sizes.append(None)
            notes.append(
                (len(rows), encode_text(fs_error_line("wc", path, exc)))
            )
            continue
        except FS_ERRORS as exc:
            notes.append(
                (len(rows), encode_text(fs_error_line("wc", path, exc)))
            )
            continue
        rows.append((counts, path.raw_path))
        named.append((path, run))
        sizes.append(None if is_stdin(path) else counts.bytes_)
        totals.merge(counts)
    width = (
        None
        if pushed
        else 1
        if listed_from == "-"
        else number_width(sizes, len(paths), shown_counts(flags))
    )
    records = [
        PathRecord(
            path,
            run,
            values=tuple(
                _selected_values(
                    counts,
                    lines=lines,
                    words=words,
                    bytes_=bytes_,
                    chars=chars,
                    max_line_length=max_line_length,
                )
            ),
        )
        for (counts, _), (path, run) in zip(rows, named)
    ]
    printed = count_lines(rows, totals, len(paths), flags, width)
    starts = [0]
    for line in printed:
        starts.append(starts[-1] + len(format_records([line])))
    placed = [
        (0 if flags.total == "only" else starts[min(row, len(printed))], line)
        for row, line in notes
    ]
    return format_records(printed), placed, records


def _listed_refusal(listed_from: str, path: PathSpec, run: int) -> str:
    """The line refusing one ``--files0-from`` entry, empty for none.

    Args:
        listed_from (str): the list as typed, ``-`` for stdin.
        path (PathSpec): the entry.
        run (int): the entry's index in the list.
    """
    if path.raw_path == "":
        return (
            f"wc: {shell_quote(listed_from)}:{run + 1}: {ZERO_LENGTH_NAME}\n"
        )
    if listed_from == "-" and path.raw_path == "-":
        return "wc: when reading file names from stdin, no file name of '-' allowed\n"
    return ""


async def _listed(
    source: PathSpec,
    stream: Callable[[PathSpec], AsyncIterator[bytes]],
    cwd: PathSpec,
) -> list[PathSpec] | IOResult:
    """The paths a ``--files0-from`` list names, or wc's refusal of the
    list itself.

    Args:
        source (PathSpec): the list, ``-`` for stdin.
        stream (Callable[[PathSpec], AsyncIterator[bytes]]): the reader.
        cwd (PathSpec): where a relative name is resolved.
    """
    label = source.raw_path if source.raw_path is not None else source.virtual
    try:
        names = await listed_names(source, stream)
    except IsADirectoryError as exc:
        line = f"wc: {shell_quote(label)}: read error: {fs_strerror(exc)}\n"
        return IOResult(exit_code=1, stderr=encode_text(line))
    except FS_ERRORS as exc:
        line = (
            f"wc: cannot open {shell_quote_always(label)} for reading: "
            f"{fs_strerror(exc)}\n"
        )
        return IOResult(exit_code=1, stderr=encode_text(line))
    return [PathSpec.from_str_path(name, cwd=cwd) for name in names]


async def wc_generic(
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    stream: PolymorphicReadFn,
    line_count: Callable[[PathSpec], Awaitable[int | None]] | None = None,
    size_of: Callable[[PathSpec], Awaitable[int | None]] | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Run wc over resolved operands, GNU semantics; mirrors wcGeneric.

    The wiring resolves globs and binds the backend reader (usually the
    dir-aware stream, so a directory operand reports ``Is a directory``);
    everything else lives here: flag parsing, per-operand
    report-and-continue via ``format_multi``, the total row, and the
    stdin fallback. A read is its own probe, so no separate stat is
    taken, except under ``-c`` alone, where the stat is the answer.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by wc.
        ctx (Context): Flags and stdin from the dispatcher.
        stream (PolymorphicReadFn): Bound reader called as
            ``stream(path)``.
        line_count (Callable[[PathSpec], Awaitable[int | None]] | None):
            the mount's ``line_count``, asked for ``-l`` alone (see
            ``format_multi``).
        size_of (Callable[[PathSpec], Awaitable[int | None]] | None):
            a regular file's size, asked for ``-c`` alone.
    """
    try:
        parsed = parse_flags(ctx.flags)
    except UsageError as exc:
        return None, IOResult(
            exit_code=exc.exit_code, stderr=encode_text(str(exc) + "\n")
        )
    except ValueError as exc:
        return None, IOResult(exit_code=1, stderr=encode_text(str(exc) + "\n"))
    stream = stdin_stream(stream, ctx.stdin)
    listed_from = None
    if parsed.files0_from is not None:
        if paths:
            word = paths[0].raw_path or paths[0].virtual
            line = (
                f"wc: extra operand {shell_quote_always(word)}\n"
                "file operands cannot be combined with --files0-from\n"
                f"{usage_hint('wc')}\n"
            )
            return None, IOResult(exit_code=1, stderr=encode_text(line))
        listed = await _listed(parsed.files0_from, stream, ctx.cwd)
        if isinstance(listed, IOResult):
            return None, listed
        named = parsed.files0_from
        listed_from = (
            named.raw_path if named.raw_path is not None else named.virtual
        )
        paths = listed
    if paths or listed_from is not None:
        # A listed name may sit on another mount than the one that counts
        # lines, so a list reads every file it names.
        counted = line_count if listed_from is None else None
        body, notes, records = await format_multi(
            paths,
            read=stream,
            lines=parsed.lines,
            words=parsed.words,
            bytes_=parsed.bytes_,
            chars=parsed.chars,
            max_line_length=parsed.max_line_length,
            total=parsed.total,
            line_count=counted,
            size_of=size_of,
            listed_from=listed_from,
        )
        io = IOResult(exit_code=1 if notes else 0)
        io.records = records
        return at_offsets(body, notes, io), io
    source = resolve_source(ctx.stdin)
    counts = await wc(source, flags=parsed)
    if parsed.total == "only":
        values = _selected_values(
            counts,
            lines=parsed.lines,
            words=parsed.words,
            bytes_=parsed.bytes_,
            chars=parsed.chars,
            max_line_length=parsed.max_line_length,
        )
        line = " ".join(str(value) for value in values) + "\n"
        return encode_text(line), IOResult()
    rows: list[tuple[WCCounts, str | None]] = [(counts, None)]
    if parsed.total == "always":
        rows.append((counts, "total"))
    rendered = format_wc_lines(
        rows,
        lines=parsed.lines,
        words=parsed.words,
        bytes_=parsed.bytes_,
        chars=parsed.chars,
        max_line_length=parsed.max_line_length,
        width=number_width([None], 1, shown_counts(parsed)),
    )
    return format_records(rendered), IOResult()
