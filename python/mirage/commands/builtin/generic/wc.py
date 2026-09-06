import codecs
import inspect
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass
from typing import Any, Callable

from mirage.cache.read_through import cache_aware_read
from mirage.commands.builtin.utils.operands import operands_io
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.builtin.utils.stream import resolve_source
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagValue, FlagView
from mirage.io.cooperative import chunks
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec, PolymorphicReadFn
from mirage.utils.errors import FS_ERRORS, fs_error_line
from mirage.utils.width import advance_column, is_space

_TOTAL_MODES = frozenset({"auto", "always", "only", "never"})


@dataclass(frozen=True, slots=True)
class WCFlags:
    lines: bool = False
    words: bool = False
    bytes_: bool = False
    chars: bool = False
    max_line_length: bool = False
    total: str = "auto"


def parse_flags(flags: Mapping[str, FlagValue]) -> WCFlags:
    fl = FlagView(flags, spec=SPECS["wc"])
    total = fl.as_str("total") or "auto"
    if total not in _TOTAL_MODES:
        raise ValueError(f"wc: invalid argument '{total}' for '--total'")
    return WCFlags(
        lines=fl.as_bool("lines"),
        words=fl.as_bool("words"),
        bytes_=fl.as_bool("bytes"),
        chars=fl.as_bool("chars"),
        max_line_length=fl.as_bool("max_line_length"),
        total=total,
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


def _scan_text(
    text: str,
    in_word: bool,
    column: int,
    max_len: int,
) -> tuple[int, int, int, bool]:
    """Fold one chunk into the word count and the widest-line measurement.

    Word splitting and column geometry are separate questions about the same
    character: ``\\t`` both ends a word and jumps to the next tab stop, while
    a combining mark ends nothing and occupies nothing. ``max_len`` is a
    running maximum rather than a per-line one because carriage return and
    form feed rewind the column without ending the line.

    Args:
        text (str): The decoded chunk.
        in_word (bool): Whether the previous chunk ended mid-word.
        column (int): The column the previous chunk ended on.
        max_len (int): The widest line seen so far.

    Returns:
        tuple[int, int, int, bool]: words closed by this chunk, the new
            column, the new maximum, and whether it ended mid-word.
    """
    words_added = 0
    for ch in text:
        if is_space(ch):
            if in_word:
                words_added += 1
                in_word = False
        else:
            in_word = True
        if ch == "\n":
            if column > max_len:
                max_len = column
            column = 0
            continue
        column = advance_column(column, ch)
        if column > max_len:
            max_len = column
    return words_added, column, max_len, in_word


async def wc(src: bytes | AsyncIterator[bytes],
             *,
             flags: WCFlags | None = None) -> WCCounts:
    if (flags is not None and (flags.lines or flags.bytes_)
            and not (flags.words or flags.chars or flags.max_line_length)):
        counts = WCCounts()
        async for chunk in chunks(src):
            counts.bytes_ += len(chunk)
            if flags.lines:
                counts.lines += chunk.count(b"\n")
        return counts
    bytes_count = 0
    lines = 0
    words = 0
    chars = 0
    max_len = 0
    in_word = False
    column = 0
    decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")

    async for chunk in chunks(src):
        bytes_count += len(chunk)
        lines += chunk.count(b"\n")
        text = decoder.decode(chunk)
        chars += len(text)
        added, column, max_len, in_word = _scan_text(text, in_word, column,
                                                     max_len)
        words += added

    final_text = decoder.decode(b"", final=True)
    chars += len(final_text)
    added, column, max_len, in_word = _scan_text(final_text, in_word, column,
                                                 max_len)
    words += added

    if in_word:
        words += 1

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


def format_wc_lines(
    rows: list[tuple[WCCounts, str | None]],
    *,
    lines: bool = False,
    words: bool = False,
    bytes_: bool = False,
    chars: bool = False,
    max_line_length: bool = False,
) -> list[str]:
    """Format a wc report in GNU style.

    Counts are right-aligned to a shared width and space-separated; a single
    count for a single operand prints unpadded, and a default-mode stdin read
    uses GNU's width 7 for unknown sizes. Divergence from GNU: the width is
    the widest printed number, while GNU derives it from operand file sizes;
    the two are identical in the default mode, where the byte count is the
    widest column.

    Args:
        rows (list[tuple[WCCounts, str | None]]): One entry per output row
            (including any ``total`` row); ``None`` labels omit the name.
        lines (bool): Report line count only.
        words (bool): Report word count only.
        bytes_ (bool): Report byte count only.
        chars (bool): Report character count only.
        max_line_length (bool): Report longest line length only.
    """
    values = [(_selected_values(counts,
                                lines=lines,
                                words=words,
                                bytes_=bytes_,
                                chars=chars,
                                max_line_length=max_line_length), label)
              for counts, label in rows]
    if len(values) == 1 and len(values[0][0]) == 1:
        nums, label = values[0]
        body = str(nums[0])
        return [body if label is None else f"{body} {label}"]
    if len(values) == 1 and values[0][1] is None:
        width = 7
    else:
        width = max((len(str(n)) for nums, _ in values for n in nums),
                    default=1)
    out: list[str] = []
    for nums, label in values:
        body = " ".join(str(n).rjust(width) for n in nums)
        out.append(body if label is None else f"{body} {label}")
    return out


def format_count_rows(
    rows: list[tuple[WCCounts, str | None]],
    totals: WCCounts,
    operand_count: int,
    flags: WCFlags,
) -> bytes:
    if flags.total == "only":
        values = _selected_values(totals,
                                  lines=flags.lines,
                                  words=flags.words,
                                  bytes_=flags.bytes_,
                                  chars=flags.chars,
                                  max_line_length=flags.max_line_length)
        return (" ".join(str(value) for value in values) + "\n").encode()
    output_rows = list(rows)
    include_total = (flags.total == "always"
                     or (flags.total == "auto" and operand_count > 1))
    if include_total:
        output_rows.append((totals, "total"))
    return format_records(
        format_wc_lines(output_rows,
                        lines=flags.lines,
                        words=flags.words,
                        bytes_=flags.bytes_,
                        chars=flags.chars,
                        max_line_length=flags.max_line_length))


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
) -> tuple[bytes, bytes]:
    """Format wc output for multiple already-resolved paths.

    Globs are expanded by the caller (``resolve_glob``) before this runs, so
    ``paths`` is always a flat list of concrete entries, never patterns. One
    record is emitted per path, plus a trailing ``total`` row when more than
    one path is given; every record ends with a newline per POSIX wc. A
    failed operand is skipped and reported as one GNU stderr line, and the
    ``total`` row still prints (GNU wc totals the operands that resolved,
    ``0 total`` when none did).

    Args:
        paths (list[PathSpec]): Resolved paths; only ``.virtual`` is read.
        read (Callable[..., Any]): Reader called as ``read(path)``;
            returns bytes, an awaitable of bytes, or an async byte iterator.

    Returns:
        tuple[bytes, bytes]: Encoded wc output (``b""`` when nothing prints)
        and concatenated stderr lines for failed operands (``b""`` if none).
    """
    flags = WCFlags(lines=lines,
                    words=words,
                    bytes_=bytes_,
                    chars=chars,
                    max_line_length=max_line_length,
                    total=total)
    read = cache_aware_read(read)
    rows: list[tuple[WCCounts, str | None]] = []
    totals = WCCounts()
    err = b""
    for path in paths:
        try:
            source = read(path)
            if inspect.isawaitable(source):
                source = await source
            counts = await wc(source, flags=flags)
        except FS_ERRORS as exc:
            err += fs_error_line("wc", path, exc).encode()
            continue
        rows.append((counts, path.raw_path))
        totals.merge(counts)
    return format_count_rows(rows, totals, len(paths), flags), err


async def wc_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    stream: PolymorphicReadFn,
) -> tuple[ByteSource | None, IOResult]:
    """Run wc over resolved operands, GNU semantics; mirrors wcGeneric.

    The wiring resolves globs and binds the backend reader (usually the
    dir-aware stream, so a directory operand reports ``Is a directory``);
    everything else lives here: flag parsing, per-operand
    report-and-continue via ``format_multi``, the total row, and the
    stdin fallback. wc reads every operand anyway, so the read itself is
    the probe and no separate stat is taken.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by wc.
        opts (CommandOpts): Flags and stdin from the dispatcher.
        stream (PolymorphicReadFn): Bound reader called as
            ``stream(path)``.
    """
    try:
        parsed = parse_flags(opts.flags)
    except ValueError as exc:
        return None, IOResult(exit_code=1, stderr=(str(exc) + "\n").encode())
    if paths:
        body, err = await format_multi(paths,
                                       read=stream,
                                       lines=parsed.lines,
                                       words=parsed.words,
                                       bytes_=parsed.bytes_,
                                       chars=parsed.chars,
                                       max_line_length=parsed.max_line_length,
                                       total=parsed.total)
        return body, operands_io(err)
    source = resolve_source(opts.stdin, "wc: missing operand")
    counts = await wc(source, flags=parsed)
    return format_stdin(counts, parsed), IOResult()


def format_stdin(counts: WCCounts, flags: WCFlags) -> bytes:
    if flags.total == "only":
        values = _selected_values(counts,
                                  lines=flags.lines,
                                  words=flags.words,
                                  bytes_=flags.bytes_,
                                  chars=flags.chars,
                                  max_line_length=flags.max_line_length)
        return (" ".join(str(value) for value in values) + "\n").encode()
    rows: list[tuple[WCCounts, str | None]] = [(counts, None)]
    if flags.total == "always":
        rows.append((counts, "total"))
    return format_records(
        format_wc_lines(rows,
                        lines=flags.lines,
                        words=flags.words,
                        bytes_=flags.bytes_,
                        chars=flags.chars,
                        max_line_length=flags.max_line_length))
