import codecs
import inspect
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass
from typing import Any, Callable

from mirage.cache.read_through import cache_aware_read
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.types import PathSpec
from mirage.utils.errors import FS_ERRORS, fs_error_line
from mirage.utils.stream import ensure_stream

_TOTAL_MODES = frozenset({"auto", "always", "only", "never"})


@dataclass(frozen=True, slots=True)
class WCFlags:
    lines: bool = False
    words: bool = False
    bytes_: bool = False
    chars: bool = False
    max_line_length: bool = False
    total: str = "auto"


def parse_flags(flags: Mapping[str, object]) -> WCFlags:
    fl = FlagView(flags, spec=SPECS["wc"])
    total = fl.as_str("total") or "auto"
    if total not in _TOTAL_MODES:
        raise ValueError(f"wc: invalid argument '{total}' for '--total'")
    return WCFlags(
        lines=fl.as_bool("args_l") or fl.as_bool("lines"),
        words=fl.as_bool("w") or fl.as_bool("words"),
        bytes_=fl.as_bool("c") or fl.as_bool("bytes"),
        chars=fl.as_bool("m") or fl.as_bool("chars"),
        max_line_length=(fl.as_bool("L") or fl.as_bool("max_line_length")),
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
    line_len: int,
    max_len: int,
) -> tuple[int, int, int, bool]:
    words_added = 0
    for ch in text:
        if ch.isspace():
            if in_word:
                words_added += 1
                in_word = False
            if ch == "\n":
                if line_len > max_len:
                    max_len = line_len
                line_len = 0
            else:
                line_len += 1
        else:
            in_word = True
            line_len += 1
    return words_added, line_len, max_len, in_word


async def wc(src: bytes | AsyncIterator[bytes]) -> WCCounts:
    bytes_count = 0
    lines = 0
    words = 0
    chars = 0
    max_len = 0
    in_word = False
    line_len = 0
    decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")

    async for chunk in ensure_stream(src):
        bytes_count += len(chunk)
        lines += chunk.count(b"\n")
        text = decoder.decode(chunk)
        chars += len(text)
        added, line_len, max_len, in_word = _scan_text(text, in_word, line_len,
                                                       max_len)
        words += added

    final_text = decoder.decode(b"", final=True)
    chars += len(final_text)
    added, line_len, max_len, in_word = _scan_text(final_text, in_word,
                                                   line_len, max_len)
    words += added

    if in_word:
        words += 1
    if line_len > max_len:
        max_len = line_len

    return WCCounts(
        lines=lines,
        words=words,
        bytes_=bytes_count,
        chars=chars,
        max_line_length=max_len,
    )


async def wc_lines(src: bytes | AsyncIterator[bytes]) -> int:
    count = 0
    async for chunk in ensure_stream(src):
        count += chunk.count(b"\n")
    return count


def _selected_values(
    counts: WCCounts,
    *,
    args_l: bool = False,
    w: bool = False,
    c: bool = False,
    m: bool = False,
    L: bool = False,
) -> list[int]:
    selected = args_l or w or c or m or L
    if not selected:
        return [counts.lines, counts.words, counts.bytes_]
    values: list[int] = []
    if args_l:
        values.append(counts.lines)
    if w:
        values.append(counts.words)
    if m:
        values.append(counts.chars)
    if c:
        values.append(counts.bytes_)
    if L:
        values.append(counts.max_line_length)
    return values


def format_wc_lines(
    rows: list[tuple[WCCounts, str | None]],
    *,
    args_l: bool = False,
    w: bool = False,
    c: bool = False,
    m: bool = False,
    L: bool = False,
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
        args_l (bool): Report line count only.
        w (bool): Report word count only.
        c (bool): Report byte count only.
        m (bool): Report character count only.
        L (bool): Report longest line length only.
    """
    values = [(_selected_values(counts, args_l=args_l, w=w, c=c, m=m,
                                L=L), label) for counts, label in rows]
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


def format_wc(
    counts: WCCounts,
    *,
    args_l: bool = False,
    w: bool = False,
    c: bool = False,
    m: bool = False,
    L: bool = False,
    label: str | None = None,
) -> str:
    return format_wc_lines([(counts, label)],
                           args_l=args_l,
                           w=w,
                           c=c,
                           m=m,
                           L=L)[0]


def format_count_rows(
    rows: list[tuple[WCCounts, str | None]],
    totals: WCCounts,
    operand_count: int,
    flags: WCFlags,
) -> bytes:
    if flags.total == "only":
        values = _selected_values(totals,
                                  args_l=flags.lines,
                                  w=flags.words,
                                  c=flags.bytes_,
                                  m=flags.chars,
                                  L=flags.max_line_length)
        return (" ".join(str(value) for value in values) + "\n").encode()
    output_rows = list(rows)
    include_total = (flags.total == "always"
                     or (flags.total == "auto" and operand_count > 1))
    if include_total:
        output_rows.append((totals, "total"))
    return format_records(
        format_wc_lines(output_rows,
                        args_l=flags.lines,
                        w=flags.words,
                        c=flags.bytes_,
                        m=flags.chars,
                        L=flags.max_line_length))


async def format_multi(
    paths: list[PathSpec],
    *,
    read: Callable[..., Any],
    args_l: bool = False,
    w: bool = False,
    c: bool = False,
    m: bool = False,
    L: bool = False,
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
    read = cache_aware_read(read)
    rows: list[tuple[WCCounts, str | None]] = []
    totals = WCCounts()
    err = b""
    for path in paths:
        try:
            source = read(path)
            if inspect.isawaitable(source):
                source = await source
            counts = await wc(source)
        except FS_ERRORS as exc:
            err += fs_error_line("wc", path, exc).encode()
            continue
        rows.append((counts, path.raw_path))
        totals.merge(counts)
    flags = WCFlags(lines=args_l,
                    words=w,
                    bytes_=c,
                    chars=m,
                    max_line_length=L,
                    total=total)
    return format_count_rows(rows, totals, len(paths), flags), err


def format_stdin(counts: WCCounts, flags: WCFlags) -> bytes:
    if flags.total == "only":
        values = _selected_values(counts,
                                  args_l=flags.lines,
                                  w=flags.words,
                                  c=flags.bytes_,
                                  m=flags.chars,
                                  L=flags.max_line_length)
        return (" ".join(str(value) for value in values) + "\n").encode()
    rows: list[tuple[WCCounts, str | None]] = [(counts, None)]
    if flags.total == "always":
        rows.append((counts, "total"))
    return format_records(
        format_wc_lines(rows,
                        args_l=flags.lines,
                        w=flags.words,
                        c=flags.bytes_,
                        m=flags.chars,
                        L=flags.max_line_length))
