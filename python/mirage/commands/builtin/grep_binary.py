import re
from collections import deque
from collections.abc import AsyncGenerator, AsyncIterator
from dataclasses import dataclass

from mirage.commands.builtin.grep_offsets import (
    prefix_of,
)
from mirage.commands.builtin.grep_prefilter import required_needles
from mirage.commands.builtin.grep_select import WalkFilters
from mirage.commands.builtin.types import RegexSyntax
from mirage.commands.builtin.utils.pcre import match_start, match_text
from mirage.concurrency.worker import Worker
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.stream import close_quietly
from mirage.io.types import IOResult, materialize
from mirage.io.yield_budget import YieldBudget
from mirage.shell.bytes import byte_view, encode_text, from_byte_view
from mirage.utils.regex import AsyncRegex


@dataclass(frozen=True, slots=True)
class GrepFlags:
    """Parsed grep flags (TS FlagSet parity); the complete set grep honors."""

    ignore_case: bool
    invert: bool
    line_numbers: bool
    byte_offsets: bool
    count_only: bool
    files_only: bool
    files_without_match: bool
    whole_word: bool
    line_regexp: bool
    fixed_string: bool
    syntax: RegexSyntax
    only_matching: bool
    quiet: bool
    no_messages: bool
    recursive: bool
    with_filename: bool
    no_filename: bool
    max_count: int | None
    after_context: int | None
    before_context: int | None
    binary_mode: str
    filters: WalkFilters
    skip_directories: bool = False
    skip_devices: bool = False
    null_data: bool = False
    null: bool = False
    initial_tab: bool = False
    group_separator: bytes | None = b"--"
    label: str = "(standard input)"
    # -R: the recursion follows every link it meets, not only the
    # command line's.
    dereference: bool = False


# GNU grep's INITIAL_BUFSIZE: the window it examines before printing from it.
PROBE_BLOCK_BYTES = 96 * 1024
# The digits of INTMAX_MAX, the width -T pads to when the input's size is
# unknown (a pipe).
UNKNOWN_SIZE_WIDTH = 19


def group_line(f: GrepFlags) -> bytes:
    """The line grep prints between two context groups, or nothing.

    GNU separates groups once -A, -B or -C is given, zero included and
    under -o too (grep 3.11: `grep -A0` prints `--` between two lines
    that are not neighbours); -c, -l, -L and -q print no lines.

    Args:
        f (GrepFlags): parsed flags.
    """
    if f.count_only or f.files_only or f.files_without_match or f.quiet:
        return b""
    if f.group_separator is None or (
        f.after_context is None and f.before_context is None
    ):
        return b""
    return f.group_separator + b"\n"


def name_end(f: GrepFlags) -> bytes:
    """What follows a file name -l or -L prints: NUL under -Z.

    Args:
        f (GrepFlags): parsed flags.
    """
    return b"\0" if f.null else b"\n"


def offset_width(f: GrepFlags, size: int | None) -> int:
    """The width -T pads line numbers and byte offsets to.

    GNU sizes the field to the digits of the file's size, plus one under
    -n, and to INTMAX_MAX's digits when the size is unknown (grep.c).

    Args:
        f (GrepFlags): parsed flags.
        size (int | None): the input's size, None for a pipe.
    """
    if not f.initial_tab:
        return 0
    if size is None:
        return UNKNOWN_SIZE_WIDTH
    return len(str(size + (1 if f.line_numbers else 0)))


class BinaryInput:
    def __init__(self, mode: str, nul_ends_line: bool = False) -> None:
        self.mode = mode
        self.nul = False
        # Under -z a NUL ends a line, so it is no sign of a binary file.
        self.nul_ends_line = nul_ends_line

    async def read(self, source: AsyncIterator[bytes]) -> AsyncIterator[bytes]:
        """Probe the input for NUL a block at a time, then pass it on.

        GNU examines what one read() returned before printing from it: a
        whole buffer for a regular file, whatever had arrived for a pipe.
        A transport chunk is the pipe case, and it is not merged with later
        chunks because a -m1 over a row stream must not pull the rest of
        the collection to fill a window; a chunk a backend serves whole is
        cut into GNU-sized blocks so it behaves as the file case.

        Args:
            source (AsyncIterator[bytes]): the input as the backend serves it.
        """
        async for chunk in source:
            for offset in range(0, len(chunk), PROBE_BLOCK_BYTES):
                block = chunk[offset : offset + PROBE_BLOCK_BYTES]
                if self.stops(block):
                    return
                yield self.deliver(block)

    def stops(self, data: bytes) -> bool:
        """Note a NUL in data; True when without-match must stop reading.

        Args:
            data (bytes): bytes that all belong to the block being probed.
        """
        if (
            self.mode != "text"
            and not self.nul_ends_line
            and not self.nul
            and b"\0" in data
        ):
            self.nul = True
        return self.nul and self.mode == "without-match"

    def deliver(self, block: bytes) -> bytes:
        return block.replace(b"\0", b"\n") if self.nul else block


async def binary_notice(io: IOResult, path: str) -> None:
    """Append GNU's binary-file notice to the input's stderr.

    Args:
        io (IOResult): the input's result.
        path (str): the name the notice carries.
    """
    io.stderr = (
        await materialize(io.stderr)
    ) + f"grep: {path}: binary file matches\n".encode()


def valid_utf8(data: bytes) -> bool:
    """Whether every byte of ``data`` belongs to a UTF-8 character.

    Args:
        data (bytes): the output to check.
    """
    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        return False
    return True


def output_line(
    raw: bytes,
    number: int,
    selected: bool,
    path: str,
    show_filename: bool,
    f: GrepFlags,
    offset: int = 0,
    width: int = 0,
) -> bytes:
    """One output line, prefix fields in GNU's fixed order.

    -Z puts a NUL after the name in place of its separator, -T pads the
    numbers and puts a tab before a nonempty line, and -z ends the line
    with a NUL.

    Args:
        raw (bytes): the text to print, without a terminator.
        number (int): the line's number, printed under -n.
        selected (bool): False for a context line, which renders every
            field with ``-`` rather than ``:``.
        path (str): the name the line carries under -H.
        show_filename (bool): whether it carries one.
        f (GrepFlags): parsed flags.
        offset (int): the byte offset printed under -b -- of the line's
            own start, or of the match itself under -o.
        width (int): the field width -T pads the numbers to.
    """
    separator = b":" if selected else b"-"
    prefix = (
        path.encode() + (b"\0" if f.null else separator)
        if show_filename
        else b""
    )
    fields = prefix_of(
        number if f.line_numbers else None,
        offset if f.byte_offsets else None,
        selected,
        width,
    ).encode()
    tab = b"\t" if f.initial_tab and (prefix or fields) and raw else b""
    return prefix + fields + tab + raw + (b"\0" if f.null_data else b"\n")


async def grep_input(
    source: AsyncIterator[bytes],
    pat: re.Pattern[str],
    f: GrepFlags,
    path: str,
    show_filename: bool,
    io: IOResult,
    after_output: bool = False,
    utf8: bool = False,
    size: int | None = None,
    worker: Worker | None = None,
) -> AsyncGenerator[bytes, None]:
    """Scan one input, yielding grep's output for it.

    Under a UTF-8 locale a line is matched as text, and a line or match
    to print that holds a byte no character owns is binary output: GNU
    leaves it out and ends with the binary-file notice, as it does for
    a NUL, but goes on printing the lines after it.

    Args:
        source (AsyncIterator[bytes]): the input's bytes.
        pat (re.Pattern[str]): the compiled pattern.
        f (GrepFlags): parsed flags.
        path (str): the name output lines carry.
        show_filename (bool): whether output lines carry the name.
        io (IOResult): receives the exit status and any notice.
        after_output (bool): whether an earlier input already printed
            lines; GNU then opens this input's first context group with
            the separator, as it does between groups within one input.
        utf8 (bool): match characters rather than bytes.
        size (int | None): the input's size, which -T sizes its fields
            to; None for a pipe.
        worker (Worker | None): shared worker for a multi-file invocation.
    """
    budget = YieldBudget()
    io.exit_code = 1
    eol = b"\0" if f.null_data else b"\n"
    width = offset_width(f, size)
    binary = BinaryInput(f.binary_mode, f.null_data)
    count = 0
    notified = False
    after = f.after_context or 0
    previous: deque[tuple[int, bytes, int]] = deque(
        maxlen=f.before_context or 0
    )
    separator = group_line(f)
    last_printed = 0
    after_until = 0
    # Context lines are tracked under -o too, which prints none of them
    # but still separates the groups they belong to.
    has_context = bool(after or f.before_context)
    if f.max_count == 0:
        # GNU selects no line at all and the whole command goes quiet:
        # `grep -m0 -c a f` prints NOTHING and exits 1, and so does
        # `grep -m0 -c a f g` -- no per-file zeros either. That is not the
        # same as a genuine zero, which `grep -c a g` still prints as `0`,
        # so -c cannot answer from the count here. Measured on GNU grep
        # 3.11 across `-m0`, `-m 0` and `--max-count=0`. -L is the one
        # flag that still speaks: nothing selected means the file is
        # listed (`grep -m0 -L a f` prints f, exit 1).
        # Nothing is read, but the backend already opened the source.
        await close_quietly(source)
        if f.files_without_match and not f.quiet:
            yield path.encode() + name_end(f)
        return
    number = 0
    # GNU counts BYTES from the start of the input and keeps counting
    # across lines, so the position is advanced by one more than the line
    # to cover the terminator the iterator strips. The extra byte past a
    # final line with no newline is never read.
    byte_pos = 0
    needles = (
        required_needles(pat)
        if not f.invert
        and (
            not has_context
            or f.count_only
            or f.quiet
            or f.files_only
            or f.files_without_match
        )
        else None
    )
    fold = bool(pat.flags & re.IGNORECASE)
    matcher = AsyncRegex(pat, all_matches=f.only_matching, worker=worker)
    input_stream = binary.read(source)
    lines = AsyncLineIterator(input_stream)
    try:
        while True:
            if needles is not None:
                skipped, length = lines.skip_nonmatching_lines(
                    needles, fold, eol
                )
                number += skipped
                byte_pos += length
            raw = await lines.readline(eol)
            if raw is None:
                break
            if binary.nul and f.binary_mode == "without-match":
                break
            number += 1
            line_start = byte_pos
            byte_pos += len(raw) + 1
            line = byte_view(raw, utf8)
            await matcher.prepare(
                line,
                lambda: (
                    (
                        byte_view(item, utf8)
                        for item in lines.buffered_lines(
                            eol, needles=needles, ignore_case=fold
                        )
                    )
                    if f.max_count is None
                    and not (f.quiet or f.files_only or f.files_without_match)
                    else ()
                ),
            )
            hit = bool(matcher.search(line)) != f.invert
            if f.max_count is not None and count >= f.max_count:
                hit = False
            if hit:
                count += 1
                io.exit_code = 0
                if f.quiet:
                    return
                if f.files_only:
                    yield path.encode() + name_end(f)
                    return
                if f.files_without_match:
                    # A selected line is all -L needs to know: the file
                    # is not listed, and the status still says it matched.
                    return
            # NUL runs become empty lines. Batch decisions only when no
            # per-line output or context must be retained.
            if not raw and (f.count_only or (not hit and not has_context)):
                limit = (
                    f.max_count - count
                    if hit and f.max_count is not None
                    else None
                )
                skipped = lines.skip_empty_lines(limit, eol)
                number += skipped
                byte_pos += skipped
                if hit:
                    count += skipped
            if f.count_only:
                if f.max_count is not None and count >= f.max_count:
                    break
                continue
            chunks: list[bytes] = []
            if hit:
                pending = [
                    (n, data, at)
                    for n, data, at in previous
                    if n > last_printed
                ]
                first = pending[0][0] if pending else number
                if separator and (
                    (last_printed and first > last_printed + 1)
                    or (not last_printed and after_output)
                ):
                    chunks.append(separator)
                if not f.only_matching:
                    chunks.extend(
                        output_line(
                            data, n, False, path, show_filename, f, at, width
                        )
                        for n, data, at in pending
                    )
                last_printed = number
                after_until = number + after
                if f.only_matching:
                    if not f.invert:
                        for m in matcher.finditer(line):
                            await budget.run()
                            text = match_text(m)
                            start = match_start(m)
                            if text:
                                chunks.append(
                                    output_line(
                                        from_byte_view(text, utf8),
                                        number,
                                        True,
                                        path,
                                        show_filename,
                                        f,
                                        line_start
                                        + (
                                            len(encode_text(line[:start]))
                                            if utf8
                                            else start
                                        ),
                                        width,
                                    )
                                )
                else:
                    chunks.append(
                        output_line(
                            raw,
                            number,
                            True,
                            path,
                            show_filename,
                            f,
                            line_start,
                            width,
                        )
                    )
            elif number <= after_until:
                if not f.only_matching:
                    chunks.append(
                        output_line(
                            raw,
                            number,
                            False,
                            path,
                            show_filename,
                            f,
                            line_start,
                            width,
                        )
                    )
                last_printed = number
            # A selected line with nothing to print (-o on a zero-width
            # match) still earns the notice.
            if (
                hit
                and not chunks
                and binary.nul
                and (f.binary_mode == "binary" and not notified)
            ):
                await binary_notice(io, path)
                notified = True
            for chunk in chunks:
                if f.binary_mode != "text" and (
                    binary.nul or (utf8 and not valid_utf8(chunk))
                ):
                    if f.binary_mode == "binary" and not notified:
                        await binary_notice(io, path)
                        notified = True
                    continue
                yield chunk
            if binary.nul and count and f.binary_mode == "binary":
                return
            previous.append((number, raw, line_start))
            if (
                f.max_count is not None
                and count >= f.max_count
                and number >= after_until
            ):
                break
    finally:
        await matcher.close()
        await close_quietly(input_stream)
        await close_quietly(source)

    # Detection can end input without yielding another line.
    if binary.nul and f.binary_mode == "without-match":
        count = 0
        io.exit_code = 1

    # -L lists the file once it is known to hold no selected line, and
    # outranks -c (GNU 3.11: `grep -L -c hello m o` prints only `o`).
    if f.files_without_match and not f.quiet:
        yield path.encode() + name_end(f)
        return
    if f.count_only and not (f.quiet or f.files_only):
        label = path.encode() + (b"\0" if f.null else b":")
        yield (label if show_filename else b"") + f"{count}\n".encode()
