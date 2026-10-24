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
from mirage.io.yield_budget import YieldBudget
from mirage.rs.stream import close_stream, open_stream
from mirage.shell.bytes import byte_view
from mirage.types import JsonValue, PathSpec, PolymorphicReadFn

logger = logging.getLogger(__name__)

_TRY_HELP = "\n" + usage_hint(CommandName.CMP)


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
    """One operand's bytes as cmp pulls them, its first chunk read on
    open, which is where an unreadable operand fails."""

    def __init__(self, source: ByteSource) -> None:
        self._source = chunks(source)
        self.held: bytes | None = None

    async def open(self) -> None:
        self.held = await anext(self._source, b"")

    async def next(self) -> bytes | None:
        """The next chunk, None at the end."""
        held, self.held = self.held, None
        if held is not None:
            return held or None
        return await anext(self._source, None)

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
    options: dict[str, JsonValue] = {
        "silent": silent,
        "verbose": verbose,
        "limit": limit,
        "print_bytes": print_bytes,
    }
    if is_stdin(p0) and is_stdin(p1):
        return await _one_stdin_twice(read, p0, skip, options)
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
                await operand.open()
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
        return await _compare(
            (operands[0], operands[1]),
            {
                **options,
                "names": [
                    byte_view(p.raw_path or p.virtual) for p in (p0, p1)
                ],
                "piped": [is_stdin(p0), is_stdin(p1)],
                "skip": list(skip),
            },
        )
    finally:
        for operand in operands:
            await operand.close()


async def _compare(
    operands: tuple[_Operand, _Operand], config: Mapping[str, JsonValue]
) -> tuple[ByteSource | None, IOResult]:
    """cmp's answer for two opened operands: the mirage-rs stream skips,
    compares and words it, and asks for the operand it needs next, so
    without -l the reads stop at the first difference.

    Args:
        operands (tuple[_Operand, _Operand]): the two inputs.
        config (Mapping[str, JsonValue]): the stream's configuration.
    """
    stream = open_stream("cmp", config)
    budget = YieldBudget()
    out: list[bytes] = []
    try:
        while (index := stream.wants()) is not None:
            chunk = await operands[index].next()
            out.append(
                stream.end_input(index)
                if chunk is None
                else stream.feed_input(index, chunk)
            )
            while stream.busy():
                await budget.run()
                out.append(stream.drain())
        out.append(stream.finish())
        while stream.busy():
            await budget.run()
            out.append(stream.drain())
    finally:
        await close_stream(stream)
    return b"".join(out) or None, IOResult(
        exit_code=stream.status(), stderr=stream.take_stderr() or None
    )


async def _one_stdin_twice(
    read: Callable[[PathSpec], AsyncIterator[bytes]],
    p: PathSpec,
    skip: tuple[int, int],
    options: Mapping[str, JsonValue],
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
        options (Mapping[str, JsonValue]): -s, -l, -n and -b as the stream
            takes them.
    """
    if skip[0] == skip[1] or skip[1] == 0:
        return None, IOResult()
    data = await materialize(read(p))
    left = (max(len(data) - skip[0], 0), max(len(data) - sum(skip), 0))
    limit = options["limit"]
    if options["silent"] and left[0] != left[1]:
        if not isinstance(limit, int) or min(left) < limit:
            return None, IOResult(exit_code=1)
    stdout, io = await _compare(
        (_Operand(data[skip[0] + skip[1] :]), _Operand(b"")),
        {
            **options,
            "names": ["-", "-"],
            "piped": [True, True],
            "skip": [0, 0],
        },
    )
    held = await materialize(io.stderr) if io.stderr is not None else b""
    io.stderr = held + b"cmp: -: Bad file descriptor\n"
    io.exit_code = 2
    return stdout, io


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
