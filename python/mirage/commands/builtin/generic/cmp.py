import logging
from collections.abc import (
    AsyncIterator,
    Awaitable,
    Callable,
    Mapping,
    Sequence,
)
from dataclasses import dataclass

from mirage.commands.builtin.constants import (
    CMP_SIZE_UNITS,
    INTMAX,
    SUFFIXED_COUNT_PATTERN,
)
from mirage.commands.builtin.utils.constants import STDIN_OPERAND
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.builtin.utils.size_suffix import parse_base0
from mirage.commands.builtin.utils.stream import is_stdin, stdin_stream
from mirage.commands.config import Context
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import CommandName, FlagValue
from mirage.commands.spec.usage import (
    extra_operand_error,
    missing_operand_error,
    usage_hint,
)
from mirage.errors.constants import FS_ERRORS
from mirage.errors.render import format_fs_error
from mirage.io.cooperative import chunks
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.types import PathSpec, PolymorphicReadFn

logger = logging.getLogger(__name__)

_TRY_HELP = "\n" + usage_hint(CommandName.CMP)
_NEWLINE = ord(b"\n")


def parse_count(raw: str, option: str, shown: str | None = None) -> int:
    """One GNU ``cmp`` byte count, read the way diffutils 3.10 reads it.

    Base 0, so ``010`` is 8 and ``0x400`` is 1024; one leading ``+`` and
    leading whitespace are allowed; the remainder is a size suffix from
    ``cmp``'s own letter set. Every rejection -- unparsable digits,
    unknown suffix, or a product past ``INTMAX`` -- is the same usage
    error naming the long option, not a crash and not od's "too large".

    Args:
        raw (str): the count to read.
        option (str): the long option name for the diagnostic, e.g.
            ``--bytes``.
        shown (str | None): the spelling to name in the diagnostic when
            it differs from ``raw``. GNU prints the operand from the
            position it was reading, so a bad ``SKIP1`` names the whole
            ``SKIP1:SKIP2`` pair while a bad ``SKIP2`` names only itself.

    Raises:
        UsageError: the operand is not a count cmp accepts.
    """
    named = raw if shown is None else shown
    error = UsageError(f"cmp: invalid {option} value '{named}'{_TRY_HELP}")
    match = SUFFIXED_COUNT_PATTERN.match(raw)
    if match is None:
        raise error
    digits, suffix = match.group(1), match.group(2)
    if suffix and suffix not in CMP_SIZE_UNITS:
        raise error
    count = parse_base0(digits) * (CMP_SIZE_UNITS[suffix] if suffix else 1)
    if count > INTMAX:
        raise error
    return count


def parse_skip(raw: str) -> tuple[int, int]:
    """The ``-i`` operand as one skip per file.

    GNU takes ``SKIP`` for both files or ``SKIP1:SKIP2`` for one each,
    so ``-i 0:3`` compares all of the first file against the fourth
    byte onward of the second. A colon is the only place the first
    count may stop, which is why ``1b:1`` is rejected naming the whole
    pair while ``1:1b`` is rejected naming just ``1b``.

    Args:
        raw (str): the ``-i`` operand as typed.
    """
    first, sep, second = raw.partition(":")
    head = parse_count(first, "--ignore-initial", raw)
    if not sep:
        return head, head
    return head, parse_count(second, "--ignore-initial")


def visible(byte: int) -> str:
    """One byte rendered the way GNU ``cmp -b`` renders it.

    The cat -v alphabet: a control byte becomes ``^X`` (so tab is
    ``^I``, unlike ``cat -v`` itself), DEL becomes ``^?``, and a high
    byte becomes ``M-`` followed by the same rules on its low seven
    bits.

    Args:
        byte (int): the byte value.
    """
    if byte >= 128:
        return "M-" + visible(byte - 128)
    if byte == 127:
        return "^?"
    if byte < 32:
        return f"^{chr(byte + 64)}"
    return chr(byte)


def offset_width(sizes: list[int], limit: int | None) -> int:
    """The width GNU ``cmp -l`` pads its offset column to.

    GNU sizes the column for the largest offset it could print: the
    ``-n`` limit, cut to the bytes left in each regular file after its
    skip. A stream has no size to cut by, so a line comparing two of
    them pads to the width of the largest file offset.

    Args:
        sizes (list[int]): bytes left after the skip in each regular
            operand; a stream contributes none.
        limit (int | None): the ``-n`` count, if given.
    """
    most = min([limit if limit is not None else INTMAX, *sizes])
    return len(str(max(most, 0)))


def operand_skips(
    texts: Sequence[str], skip: tuple[int, int]
) -> tuple[int, int]:
    """The skips cmp's SKIP1 and SKIP2 operands give, beside -i's.

    Each is read as -i reads its counts, and each file keeps the larger
    of the two skips it was given: a smaller one, from -i or from an
    operand, never lowers the other. Past the fourth operand is an extra
    one, which GNU cmp refuses only after both skips have parsed.

    Args:
        texts (Sequence[str]): the operands after FILE1 and FILE2.
        skip (tuple[int, int]): what -i gave each file.

    Raises:
        UsageError: a skip is not a count cmp accepts, or an extra
            operand follows them.
    """
    skips = list(skip)
    for f, raw in enumerate(texts[:2]):
        skips[f] = max(skips[f], parse_count(raw, "--ignore-initial"))
    if len(texts) > 2:
        raise extra_operand_error(CommandName.CMP, texts[2])
    return skips[0], skips[1]


class _Operand:
    """One operand's bytes as cmp pulls them, a chunk at a time."""

    def __init__(self, source: bytes | AsyncIterator[bytes]) -> None:
        self._source = chunks(source)
        self.held = b""

    async def pull(self) -> bool:
        """Hold the next chunk when none is held; False at the end."""
        if not self.held:
            self.held = await anext(self._source, b"")
        return bool(self.held)

    async def skip(self, count: int) -> None:
        """Drop the first ``count`` bytes.

        Args:
            count (int): how many.
        """
        while count > 0 and await self.pull():
            dropped = len(self.held[:count])
            self.held = self.held[count:]
            count -= dropped

    async def rest(self, limit: int | None) -> bytes:
        """What is left, up to ``limit`` bytes.

        Args:
            limit (int | None): the most to read, None for all of it.
        """
        parts: list[bytes] = []
        left = limit
        while (left is None or left > 0) and await self.pull():
            part = self.held if left is None else self.held[:left]
            self.held = self.held[len(part) :]
            parts.append(part)
            if left is not None:
                left -= len(part)
        return b"".join(parts)

    async def close(self) -> None:
        await self._source.aclose()


async def _sizes_differ(
    size_of: Callable[[PathSpec], Awaitable[int | None]],
    paths: tuple[PathSpec, PathSpec],
    skip: tuple[int, int],
    limit: int | None,
) -> bool:
    """Whether ``-s`` can answer 1 from two regular files' sizes, unread.

    diffutils does when the bytes left past each skip differ and the
    shorter run ends within ``-n``. A stdin operand, or a size the stat
    does not give, leaves it to the read, as does a stat that fails,
    which the read then reports.

    Args:
        size_of (Callable): a regular file's size, None when unknown.
        paths (tuple[PathSpec, PathSpec]): the two operands.
        skip (tuple[int, int]): each file's skip.
        limit (int | None): -n.
    """
    left: list[int] = []
    for p, past in zip(paths, skip):
        if is_stdin(p):
            return False
        try:
            size = await size_of(p)
        except FS_ERRORS as exc:
            logger.debug("cmp: no size for %s: %s", p.virtual, exc)
            return False
        if size is None:
            return False
        left.append(max(size - past, 0))
    return left[0] != left[1] and (limit is None or min(left) < limit)


async def cmp_cmd(
    paths: list[PathSpec],
    texts: Sequence[str] = (),
    *,
    stream: PolymorphicReadFn,
    size_of: Callable[[PathSpec], Awaitable[int | None]] | None = None,
    stdin: ByteSource | None = None,
    silent: bool = False,
    verbose: bool = False,
    limit: int | None = None,
    print_bytes: bool = False,
    skip: tuple[int, int] = (0, 0),
    argv: Sequence[str] = (),
) -> tuple[ByteSource | None, IOResult]:
    """Compare two files byte by byte, GNU cmp semantics.

    Each file is streamed and the reads stop at the first difference,
    or at ``-n``; only ``-l``, which lists every difference, reads both
    to the end. Under ``-s`` two regular files whose sizes past their
    skips differ answer 1 unread, as diffutils does.

    Args:
        paths (list[PathSpec]): FILE1 and FILE2; a lone FILE1 is
            compared with stdin.
        texts (Sequence[str]): SKIP1 and SKIP2.
        stream (PolymorphicReadFn): bound reader called as
            ``stream(path)``.
        size_of (Callable | None): a regular file's size, for ``-s``.
        stdin (ByteSource | None): the line's input.
        silent (bool): -s.
        verbose (bool): -l.
        limit (int | None): -n.
        print_bytes (bool): -b.
        skip (tuple[int, int]): -i, one skip per file.
        argv (Sequence[str]): the command's words, for usage errors.
    """
    if not paths:
        raise missing_operand_error(CommandName.CMP, None, argv)
    skip = operand_skips(texts, skip)
    # A lone FILE1 is compared with stdin, which GNU names `-`.
    p0, p1 = paths[0], paths[1] if len(paths) > 1 else STDIN_OPERAND
    read = stdin_stream(stream, stdin, sole=True)
    if is_stdin(p0) and is_stdin(p1):
        return await _one_stdin_twice(
            read, p0, skip, silent, verbose, limit, print_bytes
        )
    names = (p0.raw_path or p0.virtual, p1.raw_path or p1.virtual)
    if (
        silent
        and size_of is not None
        and not (p0.virtual == p1.virtual and skip[0] == skip[1])
        and await _sizes_differ(size_of, (p0, p1), skip, limit)
    ):
        return None, IOResult(exit_code=1)
    # GNU cmp reserves exit 1 for "files differ"; trouble is exit 2.
    # diffutils 3.10 opens both operands before it reads either, and -s
    # drops the message only for an operand it cannot open: a directory
    # opens, fails at its first read, and is reported whatever -s says,
    # unless both operands name it, which is the same file at the same
    # offset and so equal unread. Opening is the first chunk's pull.
    operands: list[_Operand] = []
    try:
        unread: IsADirectoryError | None = None
        for p in (p0, p1):
            operand = _Operand(read(p))
            operands.append(operand)
            try:
                await operand.pull()
            except IsADirectoryError as exc:
                unread = unread or exc
                operand.held = b""
            except FS_ERRORS as exc:
                return None, IOResult(
                    exit_code=2,
                    stderr=(
                        None if silent else format_fs_error("cmp", exc, paths)
                    ),
                )
        if p0.virtual == p1.virtual and skip[0] == skip[1]:
            return None, IOResult()
        if unread is not None:
            return None, IOResult(
                exit_code=2, stderr=format_fs_error("cmp", unread, paths)
            )
        first, second = operands
        await first.skip(skip[0])
        await second.skip(skip[1])
        return await _answered(
            first,
            second,
            names,
            (is_stdin(p0), is_stdin(p1)),
            silent,
            verbose,
            limit,
            print_bytes,
        )
    finally:
        for operand in operands:
            await operand.close()


async def _answered(
    first: _Operand,
    second: _Operand,
    names: tuple[str, str],
    piped: tuple[bool, bool],
    silent: bool,
    verbose: bool,
    limit: int | None,
    print_bytes: bool,
) -> tuple[ByteSource | None, IOResult]:
    """cmp's answer for two inputs past their skips: read to the first
    difference, or with -l, which lists every one, to the end.

    Args:
        first (_Operand): the first input.
        second (_Operand): the second.
        names (tuple[str, str]): the two operands as typed.
        piped (tuple[bool, bool]): whether each is stdin, which has no
            size to width -l's offset column.
        silent (bool): -s.
        verbose (bool): -l.
        limit (int | None): -n.
        print_bytes (bool): -b.
    """
    if not verbose:
        return await _streamed(
            first, second, names, silent, limit, print_bytes
        )
    data1 = await first.rest(limit)
    data2 = await second.rest(limit)
    sizes = [
        len(data) for data, pipe in zip((data1, data2), piped) if not pipe
    ]
    return _listed(data1, data2, names, sizes, silent, limit, print_bytes)


async def _streamed(
    first: _Operand,
    second: _Operand,
    names: tuple[str, str],
    silent: bool,
    limit: int | None,
    print_bytes: bool,
) -> tuple[ByteSource | None, IOResult]:
    """cmp's answer without -l, read only to the first difference.

    Args:
        first (_Operand): the first input, past its skip.
        second (_Operand): the second, past its skip.
        names (tuple[str, str]): the two operands as typed.
        silent (bool): -s.
        limit (int | None): -n.
        print_bytes (bool): -b.
    """
    compared = 0
    lines = 0
    last = -1
    while limit is None or compared < limit:
        more1 = await first.pull()
        more2 = await second.pull()
        if not more1 and not more2:
            return None, IOResult()
        if not more1 or not more2:
            if silent:
                return None, IOResult(exit_code=1)
            shorter = names[0] if not more1 else names[1]
            return None, IOResult(
                exit_code=1,
                stderr=_eof_error(shorter, compared, lines, last, False),
            )
        count = min(len(first.held), len(second.held))
        if limit is not None:
            count = min(count, limit - compared)
        a, b = first.held[:count], second.held[:count]
        if a != b:
            if silent:
                return None, IOResult(exit_code=1)
            at = next(i for i in range(count) if a[i] != b[i])
            line = 1 + lines + a[:at].count(_NEWLINE)
            return _differ(
                names, compared + at, line, a[at], b[at], print_bytes
            )
        compared += count
        lines += a.count(_NEWLINE)
        last = a[-1]
        first.held = first.held[count:]
        second.held = second.held[count:]
    return None, IOResult()


def _differ(
    names: tuple[str, str],
    at: int,
    line: int,
    byte1: int,
    byte2: int,
    print_bytes: bool,
) -> tuple[ByteSource | None, IOResult]:
    """GNU's ``differ:`` line for the first byte the files disagree on.

    Args:
        names (tuple[str, str]): the two operands as typed.
        at (int): the byte's offset from the skip, from 0.
        line (int): its line, from 1.
        byte1 (int): the first file's byte.
        byte2 (int): the second's.
        print_bytes (bool): -b.
    """
    # GNU counts in `byte` under -b and in `char` otherwise, on the same
    # offset -- the word tracks the flag, not a unit.
    unit = "byte" if print_bytes else "char"
    msg = f"{names[0]} {names[1]} differ: {unit} {at + 1}, line {line}"
    if print_bytes:
        msg += f" is {byte1:>3o} {visible(byte1)} {byte2:>3o} {visible(byte2)}"
    return format_records([msg]), IOResult(exit_code=1)


async def _one_stdin_twice(
    read: Callable[[PathSpec], AsyncIterator[bytes]],
    p: PathSpec,
    skip: tuple[int, int],
    silent: bool,
    verbose: bool,
    limit: int | None,
    print_bytes: bool,
) -> tuple[ByteSource | None, IOResult]:
    """Both operands naming the one stdin, as diffutils 3.10 answers it
    for stdin redirected from a regular file.

    One name at one skip is equal unread. Otherwise cmp skips on the
    one descriptor twice, so the files sit at the first skip and at the
    sum of both, and are equal unread when those match. -s then answers
    1 unread when the bytes left past each position differ within -n.
    Otherwise the first file reads what is left past both skips and the
    second reads nothing, and closing the descriptor a second time
    fails: that line and exit 2 follow whatever the comparison said. A
    pipe fails both seeks, which GNU takes for one position, so it
    answers 0 where this answers as the file.

    Args:
        read (Callable): the operands' reader, which stdin rides.
        p (PathSpec): the stdin operand.
        skip (tuple[int, int]): each file's skip.
        silent (bool): -s.
        verbose (bool): -l.
        limit (int | None): -n.
        print_bytes (bool): -b.
    """
    if skip[0] == skip[1] or skip[1] == 0:
        return None, IOResult()
    data = await materialize(read(p))
    left = (max(len(data) - skip[0], 0), max(len(data) - sum(skip), 0))
    if silent and left[0] != left[1]:
        if limit is None or min(left) < limit:
            return None, IOResult(exit_code=1)
    stdout, io = await _answered(
        _Operand(data[skip[0] + skip[1] :]),
        _Operand(b""),
        ("-", "-"),
        (True, True),
        silent,
        verbose,
        limit,
        print_bytes,
    )
    held = await materialize(io.stderr) if io.stderr is not None else b""
    io.stderr = held + b"cmp: -: Bad file descriptor\n"
    io.exit_code = 2
    return stdout, io


def _listed(
    data1: bytes,
    data2: bytes,
    names: tuple[str, str],
    sizes: list[int],
    silent: bool,
    limit: int | None,
    print_bytes: bool,
) -> tuple[ByteSource | None, IOResult]:
    """cmp -l's answer for two inputs read past their skips and within
    ``-n``: a row for every byte they differ on.

    Args:
        data1 (bytes): the first input's compared bytes.
        data2 (bytes): the second input's.
        names (tuple[str, str]): the two operands as typed.
        sizes (list[int]): bytes left after the skip in each regular
            operand, which size the offset column.
        silent (bool): -s.
        limit (int | None): -n.
        print_bytes (bool): -b.
    """
    if data1 == data2:
        return None, IOResult()
    if silent:
        return None, IOResult(exit_code=1)
    width = offset_width(sizes, limit)
    out_lines: list[str] = []
    for idx in range(min(len(data1), len(data2))):
        if data1[idx] != data2[idx]:
            row = f"{idx + 1:>{width}} {data1[idx]:>3o}"
            if print_bytes:
                row += f" {visible(data1[idx]):<4}"
            row += f" {data2[idx]:>3o}"
            if print_bytes:
                row += f" {visible(data2[idx])}"
            out_lines.append(row)
    io = IOResult(exit_code=1)
    if len(data1) != len(data2):
        shorter = names[0] if len(data1) < len(data2) else names[1]
        held = data1 if len(data1) < len(data2) else data2
        io.stderr = _eof_error(
            shorter, len(held), 0, held[-1] if held else -1, True
        )
    return format_records(out_lines), io


def _eof_error(
    shorter: str, held: int, lines: int, last: int, verbose: bool
) -> bytes:
    """GNU's ``EOF on FILE`` diagnostic for a common-prefix difference.

    It is a diagnostic, not output: GNU writes it to stderr and still
    exits 1. A shorter file with no bytes to compare is ``which is
    empty``. Otherwise ``-l`` reports the byte only, and every other mode
    adds the line: ``line N`` when the file ends on a newline, ``in line
    N`` when it ends inside line N.

    Args:
        shorter (str): the shorter file's operand as typed.
        held (int): how many bytes it had past its skip.
        lines (int): the newlines among them.
        last (int): the last of them, -1 for none.
        verbose (bool): whether ``-l`` is in effect.
    """
    if not held:
        return f"cmp: EOF on {shorter} which is empty\n".encode()
    msg = f"cmp: EOF on {shorter} after byte {held}"
    if not verbose:
        msg += (
            f", line {lines}" if last == _NEWLINE else f", in line {lines + 1}"
        )
    return (msg + "\n").encode()


__all__ = ["cmp_cmd"]


@dataclass(frozen=True, slots=True)
class CmpFlags:
    silent: bool = False
    verbose: bool = False
    limit: int | None = None
    print_bytes: bool = False
    skip: tuple[int, int] = (0, 0)


def parse_flags(flags: Mapping[str, FlagValue]) -> CmpFlags:
    fl = FlagView(flags, spec=SPECS["cmp"])
    silent = fl.as_bool("quiet") or fl.as_bool("silent")
    verbose = fl.as_bool("verbose")
    if silent and verbose:
        # diffutils refuses the pair while it reads the options, so ahead
        # of any operand check.
        raise UsageError(f"cmp: options -l and -s are incompatible{_TRY_HELP}")
    n_raw = fl.as_str("bytes")
    i_raw = fl.as_str("ignore_initial")
    return CmpFlags(
        silent=silent,
        verbose=verbose,
        limit=parse_count(n_raw, "--bytes") if n_raw is not None else None,
        print_bytes=fl.as_bool("print_bytes"),
        skip=parse_skip(i_raw) if i_raw is not None else (0, 0),
    )


async def cmp_generic(
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    stream: PolymorphicReadFn,
    size_of: Callable[[PathSpec], Awaitable[int | None]] | None = None,
) -> tuple[ByteSource | None, IOResult]:
    parsed = parse_flags(ctx.flags)
    return await cmp_cmd(
        paths,
        texts,
        stream=stream,
        size_of=size_of,
        stdin=ctx.stdin,
        silent=parsed.silent,
        verbose=parsed.verbose,
        limit=parsed.limit,
        print_bytes=parsed.print_bytes,
        skip=parsed.skip,
        argv=ctx.argv,
    )
