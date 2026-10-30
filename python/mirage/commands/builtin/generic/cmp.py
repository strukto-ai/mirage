import logging
from collections.abc import (
    AsyncIterator,
    Awaitable,
    Callable,
    Mapping,
    Sequence,
)
from contextlib import aclosing
from dataclasses import dataclass

from mirage.commands.builtin.utils.constants import STDIN_OPERAND
from mirage.commands.builtin.utils.stream import is_stdin, stdin_stream
from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import CommandName, FlagValue
from mirage.commands.spec.usage import (
    extra_operand_error,
    missing_operand_error,
)
from mirage.errors.constants import FS_ERRORS
from mirage.errors.render import format_fs_error
from mirage.io.cooperative import chunks
from mirage.io.stream import OutputStream
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.rs.errors import StreamRefusal
from mirage.rs.scan import refused, scan
from mirage.rs.stream import close_stream, merge_output, open_stream
from mirage.shell.bytes import byte_view
from mirage.types import JsonValue, PathSpec, PolymorphicReadFn

logger = logging.getLogger(__name__)


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
    length_of: Callable[[PathSpec], Awaitable[int | None]] | None = None,
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
        texts (Sequence[str]): SKIP1 and SKIP2, already read into
            ``skip``; a word past them is an extra operand.
        stream (PolymorphicReadFn): bound reader called as
            ``stream(path)``.
        size_of (Callable | None): a regular file's size, for ``-s``.
        stdin (ByteSource | None): the line's input.
        silent (bool): -s.
        verbose (bool): -l.
        limit (int | None): -n.
        print_bytes (bool): -b.
        skip (tuple[int, int]): each file's skip, the larger of -i's and
            its operand's.
        argv (Sequence[str]): the command's words, for usage errors.
    """
    if not paths:
        raise missing_operand_error(CommandName.CMP, None, argv)
    if len(texts) > 2:
        raise extra_operand_error(CommandName.CMP, texts[2])
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
        sizes: list[JsonValue] = [None, None]
        length_of = length_of or size_of
        if verbose and length_of is not None:
            for index, path in enumerate((p0, p1)):
                if not is_stdin(path):
                    try:
                        sizes[index] = await length_of(path)
                    except FS_ERRORS as exc:
                        logger.debug(
                            "cmp: no size for %s: %s", path.virtual, exc
                        )
        result = await _compare(
            (operands[0], operands[1]),
            {
                **options,
                "names": [
                    byte_view(p.raw_path or p.virtual) for p in (p0, p1)
                ],
                "piped": [is_stdin(p0), is_stdin(p1)],
                "skip": list(skip),
                "sizes": sizes,
            },
        )
        operands.clear()
        return result
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
    io = IOResult()

    async def read(index: int) -> bytes | None:
        return await operands[index].next()

    async def output() -> AsyncIterator[bytes]:
        try:
            async with aclosing(merge_output(stream, read)) as produced:
                async for chunk in produced:
                    yield chunk
        finally:
            io.exit_code = stream.status()
            io.stderr = stream.take_stderr() or None

    async def close() -> None:
        try:
            await close_stream(stream)
        finally:
            for operand in operands:
                await operand.close()

    result = OutputStream(output(), close)
    if not config.get("verbose"):
        return await materialize(result) or None, io
    return result, io


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
    stdout = await materialize(stdout)
    held = await materialize(io.stderr)
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


def parse_flags(
    flags: Mapping[str, FlagValue], texts: Sequence[str] = ()
) -> CmpFlags | IOResult:
    """cmp's counts read by mirage-rs before any operand is resolved.

    -n, -i, -l and -s go in the order typed, so the first refusal is
    the one diffutils makes while it reads its options, then the SKIP1
    and SKIP2 operands.

    Args:
        flags (Mapping[str, FlagValue]): the parsed flags.
        texts (Sequence[str]): the operands after FILE1 and FILE2.

    Returns:
        CmpFlags | IOResult: the flags, or cmp's refusal, exit 2.
    """
    fl = FlagView(flags, spec=SPECS["cmp"])
    typed = fl.texts("bytes", "ignore_initial", "verbose", "silent", "quiet")
    typed += [("skip", text) for text in texts[:2]]
    try:
        values = scan("cmp", typed)
    except StreamRefusal as refusal:
        return refused(refusal)
    limit = values.get("limit")
    match values.get("skip"):
        case [int(first), int(second)]:
            skip = (first, second)
        case _:
            skip = (0, 0)
    return CmpFlags(
        silent=fl.as_bool("quiet") or fl.as_bool("silent"),
        verbose=fl.as_bool("verbose"),
        limit=limit if isinstance(limit, int) else None,
        print_bytes=fl.as_bool("print_bytes"),
        skip=skip,
    )


async def cmp_generic(
    parsed: CmpFlags,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    stream: PolymorphicReadFn,
    size_of: Callable[[PathSpec], Awaitable[int | None]] | None = None,
    length_of: Callable[[PathSpec], Awaitable[int | None]] | None = None,
) -> tuple[ByteSource | None, IOResult]:
    return await cmp_cmd(
        paths,
        texts,
        stream=stream,
        size_of=size_of,
        length_of=length_of,
        stdin=ctx.stdin,
        silent=parsed.silent,
        verbose=parsed.verbose,
        limit=parsed.limit,
        print_bytes=parsed.print_bytes,
        skip=parsed.skip,
        argv=ctx.argv,
    )
