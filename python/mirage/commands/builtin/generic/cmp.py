from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass

from mirage.commands.builtin.constants import (
    CMP_SIZE_UNITS,
    INTMAX,
    XSTRTOUMAX_PATTERN,
)
from mirage.commands.builtin.utils.constants import STDIN_OPERAND
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.builtin.utils.size_suffix import parse_base0
from mirage.commands.builtin.utils.stream import is_stdin, stdin_bytes
from mirage.commands.config import CommandOpts
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
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.types import PathSpec

_TRY_HELP = "\n" + usage_hint(CommandName.CMP)
_NEWLINE = ord(b"\n")


def parse_count(raw: str, option: str, shown: str | None = None) -> int:
    """One GNU ``cmp`` byte count read the way xstrtoumax reads it.

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
    match = XSTRTOUMAX_PATTERN.match(raw)
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
    of the two skips it was given: diffutils' specify_ignore_initial
    only ever raises one. Past the fourth operand is an extra one, which
    diffutils refuses only after both skips have parsed.

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


async def cmp_cmd(
    paths: list[PathSpec],
    texts: Sequence[str] = (),
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    stdin: ByteSource | None = None,
    silent: bool = False,
    verbose: bool = False,
    limit: int | None = None,
    print_bytes: bool = False,
    skip: tuple[int, int] = (0, 0),
    argv: Sequence[str] = (),
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        raise missing_operand_error(CommandName.CMP, None, argv)
    skip = operand_skips(texts, skip)
    # A lone FILE1 is compared with stdin, which GNU names `-`.
    p0, p1 = paths[0], paths[1] if len(paths) > 1 else STDIN_OPERAND
    if is_stdin(p0) and is_stdin(p1):
        return await _one_stdin_twice(
            read_bytes, stdin, p0, skip, silent, verbose, limit, print_bytes
        )
    names = (p0.raw_path or p0.virtual, p1.raw_path or p1.virtual)
    read = stdin_bytes(read_bytes, stdin)
    # GNU cmp reserves exit 1 for "files differ"; trouble is exit 2.
    # diffutils 3.10 opens both operands before it reads either, and -s
    # drops the message only for an operand it cannot open: a directory
    # opens, fails at its first read, and is reported whatever -s says,
    # unless both operands name it, which is the same file at the same
    # offset and so equal unread.
    data: list[bytes] = []
    unread: IsADirectoryError | None = None
    for p in (p0, p1):
        try:
            data.append(await read(p))
        except IsADirectoryError as exc:
            unread = unread or exc
            data.append(b"")
        except FS_ERRORS as exc:
            return None, IOResult(
                exit_code=2,
                stderr=None if silent else format_fs_error("cmp", exc, paths),
            )
    if p0.virtual == p1.virtual and skip[0] == skip[1]:
        return None, IOResult()
    if unread is not None:
        return None, IOResult(
            exit_code=2, stderr=format_fs_error("cmp", unread, paths)
        )
    data1, data2 = data
    sizes = [len(data1) - skip[0]] if not is_stdin(p0) else []
    if not is_stdin(p1):
        sizes.append(len(data2) - skip[1])
    return _compared(
        data1[skip[0] :],
        data2[skip[1] :],
        names,
        sizes,
        silent,
        verbose,
        limit,
        print_bytes,
    )


async def _one_stdin_twice(
    read_bytes: Callable[..., Awaitable[bytes]],
    stdin: ByteSource | None,
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
        read_bytes (Callable): the backend reader, which stdin rides.
        stdin (ByteSource | None): the line's input.
        p (PathSpec): the stdin operand.
        skip (tuple[int, int]): each file's skip.
        silent (bool): -s.
        verbose (bool): -l.
        limit (int | None): -n.
        print_bytes (bool): -b.
    """
    if skip[0] == skip[1] or skip[1] == 0:
        return None, IOResult()
    data = await stdin_bytes(read_bytes, stdin)(p)
    left = (max(len(data) - skip[0], 0), max(len(data) - sum(skip), 0))
    if silent and left[0] != left[1]:
        if limit is None or min(left) < limit:
            return None, IOResult(exit_code=1)
    stdout, io = _compared(
        data[skip[0] + skip[1] :],
        b"",
        ("-", "-"),
        [],
        silent,
        verbose,
        limit,
        print_bytes,
    )
    held = await materialize(io.stderr) if io.stderr is not None else b""
    io.stderr = held + b"cmp: -: Bad file descriptor\n"
    io.exit_code = 2
    return stdout, io


def _compared(
    data1: bytes,
    data2: bytes,
    names: tuple[str, str],
    sizes: list[int],
    silent: bool,
    verbose: bool,
    limit: int | None,
    print_bytes: bool,
) -> tuple[ByteSource | None, IOResult]:
    """cmp's answer for two inputs already past their skips.

    Args:
        data1 (bytes): the first input's compared bytes.
        data2 (bytes): the second input's.
        names (tuple[str, str]): the two operands as typed.
        sizes (list[int]): bytes left after the skip in each regular
            operand, which size -l's offset column.
        silent (bool): -s.
        verbose (bool): -l.
        limit (int | None): -n.
        print_bytes (bool): -b.
    """
    if limit is not None:
        data1 = data1[:limit]
        data2 = data2[:limit]
    if data1 == data2:
        return None, IOResult()
    if silent:
        return None, IOResult(exit_code=1)
    common = min(len(data1), len(data2))
    if verbose:
        width = offset_width(sizes, limit)
        out_lines: list[str] = []
        for idx in range(common):
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
            io.stderr = _eof_error(names, data1, data2, verbose)
        return format_records(out_lines), io
    for idx in range(common):
        if data1[idx] != data2[idx]:
            line = 1 + data1[:idx].count(_NEWLINE)
            # GNU counts in `byte` under -b and in `char` otherwise, on
            # the same offset -- the word tracks the flag, not a unit.
            unit = "byte" if print_bytes else "char"
            msg = (
                f"{names[0]} {names[1]} differ: {unit} {idx + 1}, line {line}"
            )
            if print_bytes:
                msg += (
                    f" is {data1[idx]:>3o} {visible(data1[idx])}"
                    f" {data2[idx]:>3o} {visible(data2[idx])}"
                )
            return format_records([msg]), IOResult(exit_code=1)
    return None, IOResult(
        exit_code=1, stderr=_eof_error(names, data1, data2, verbose)
    )


def _eof_error(
    names: tuple[str, str],
    data1: bytes,
    data2: bytes,
    verbose: bool,
) -> bytes:
    """GNU's ``EOF on FILE`` diagnostic for a common-prefix difference.

    It is a diagnostic, not output: GNU writes it to stderr and still
    exits 1. A shorter file with no bytes to compare is ``which is
    empty``. Otherwise ``-l`` reports the byte only, and every other mode
    adds the line: ``line N`` when the file ends on a newline, ``in line
    N`` when it ends inside line N.

    Args:
        names (tuple[str, str]): the two operands as typed, in order.
        data1 (bytes): the first file's compared bytes.
        data2 (bytes): the second file's compared bytes.
        verbose (bool): whether ``-l`` is in effect.
    """
    shorter = names[0] if len(data1) < len(data2) else names[1]
    held = data1 if len(data1) < len(data2) else data2
    if not held:
        return f"cmp: EOF on {shorter} which is empty\n".encode()
    msg = f"cmp: EOF on {shorter} after byte {len(held)}"
    if not verbose:
        lines = held.count(_NEWLINE)
        msg += (
            f", line {lines}"
            if held[-1] == _NEWLINE
            else f", in line {lines + 1}"
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
    opts: CommandOpts,
    read_bytes: Callable[..., Awaitable[bytes]],
) -> tuple[ByteSource | None, IOResult]:
    parsed = parse_flags(opts.flags)
    return await cmp_cmd(
        paths,
        texts,
        read_bytes=read_bytes,
        stdin=opts.stdin,
        silent=parsed.silent,
        verbose=parsed.verbose,
        limit=parsed.limit,
        print_bytes=parsed.print_bytes,
        skip=parsed.skip,
        argv=opts.argv,
    )
