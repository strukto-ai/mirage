from collections.abc import (
    AsyncGenerator,
    Awaitable,
    Callable,
    Mapping,
    Sequence,
)
from contextlib import aclosing
from dataclasses import dataclass

from mirage.commands.builtin.utils.stream import (
    is_stdin,
    never_opened,
    stdin_stream,
)
from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.constants import LAST_WORD, OPERAND, SPELLED
from mirage.commands.spec.flag_view import FlagView, spread_operands
from mirage.commands.spec.types import CommandName, FlagValue
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import fs_strerror
from mirage.errors.render import fs_error_line
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.types import ByteSource, IOResult
from mirage.rs.errors import StreamRefusal
from mirage.rs.scan import refused, scan
from mirage.rs.stream import OpenStream, merge_output, open_stream
from mirage.shell.bytes import encode_text
from mirage.types import JsonValue, PathSpec, PolymorphicReadFn

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


@dataclass(frozen=True)
class JoinFlags:
    """join's line as mirage-rs read it.

    Attributes:
        engine (dict[str, JsonValue]): the ``join`` engine's config.
        files (tuple[int, int]): the operand positions of FILE1 and FILE2.
    """

    engine: dict[str, JsonValue]
    files: tuple[int, int]


def parse_flags(
    flags: Mapping[str, FlagValue],
    operands: Sequence[str] = (),
    argv: Sequence[str] = (),
) -> JoinFlags | IOResult:
    """Read join's options and operands in the order the line typed them.

    mirage-rs reads the tape in one pass, as GNU join's getopt loop does,
    so the first problem left to right is the one reported.

    Args:
        flags (Mapping[str, FlagValue]): the parsed flags and their tape.
        operands (Sequence[str]): the operands, in order, a glob's
            matches in its place; when the tape places none, they are
            read after every option and a ``--``, so each is a file.
        argv (Sequence[str]): the line's words after ``join``, which the
            missing-operand line names the last of.

    Returns:
        JoinFlags | IOResult: the engine's config and the two files, or
            join's refusal.

    Raises:
        ValueError: the tape places other operands than ``operands``.
    """
    typed = FlagView(flags, SPECS[CommandName.JOIN]).texts(
        OPERAND, SPELLED, *OPTION_DESTS
    )
    placed = sum(name == OPERAND for name, _ in typed)
    if placed == 0 and operands:
        typed += [(SPELLED, "--"), *((OPERAND, word) for word in operands)]
    elif placed != len(operands):
        raise ValueError(
            f"join's tape places {placed} operands, not its {len(operands)}"
        )
    if argv:
        typed.append((LAST_WORD, argv[-1]))
    try:
        values = scan("join", typed)
    except StreamRefusal as refusal:
        return refused(refusal)
    match values:
        case {"engine": dict(engine), "files": [int(first), int(second)]}:
            return JoinFlags(engine, (first, second))
    raise ValueError(f"join's scan read no engine and files: {values!r}")


def _operand_word(path: PathSpec) -> str:
    return path.raw_path


async def join(
    paths: list[PathSpec],
    *,
    read_stream: PolymorphicReadFn,
    flags: JoinFlags,
    stdin: ByteSource | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """GNU ``join`` of two files over already-parsed options.

    Args:
        paths (list[PathSpec]): the operands, of which ``flags.files``
            names the two files; ``-`` reads stdin.
        read_stream (PolymorphicReadFn): reads one operand's bytes.
        flags (JoinFlags): the options, from ``parse_flags``.
        stdin (ByteSource | None): the line's input.

    Raises:
        ValueError: ``flags.files`` names an operand ``paths`` lacks.
    """
    if not all(0 <= index < len(paths) for index in flags.files):
        raise ValueError(
            f"join's files {flags.files} are not among its operands"
        )
    file1, file2 = (paths[index] for index in flags.files)
    read = stdin_stream(read_stream, stdin)
    readers = (AsyncLineIterator(read(file1)), AsyncLineIterator(read(file2)))
    stream = open_stream("join", flags.engine)
    io = IOResult()
    return _join_stream(stream, readers, (file1, file2), io), io


def _failure(
    reader: AsyncLineIterator, path: PathSpec, exc: BaseException
) -> bytes:
    """join's line for an operand it cannot read: named as a missing one
    when it never opened, else as a read error.

    Args:
        reader (AsyncLineIterator): the operand's reader.
        path (PathSpec): the operand.
        exc (BaseException): what the read raised.
    """
    if never_opened(reader, path, exc):
        return encode_text(fs_error_line(CommandName.JOIN, path, exc))
    return encode_text(f"join: read error: {fs_strerror(exc) or exc}\n")


async def _open_inputs(
    readers: tuple[AsyncLineIterator, AsyncLineIterator],
    paths: tuple[PathSpec, PathSpec],
) -> bytes:
    """Open both files before reading either, as GNU does: a missing FILE2
    is reported over a FILE1 that cannot be read (`join dir missing`).
    Stdin is already open, so it is never read here: `join dir -` reports
    the directory without waiting on input.

    Args:
        readers (tuple[AsyncLineIterator, AsyncLineIterator]): the inputs.
        paths (tuple[PathSpec, PathSpec]): the operands.
    """
    unreadable: tuple[int, BaseException] | None = None
    for side in (0, 1):
        if is_stdin(paths[side]):
            continue
        try:
            await readers[side].peek()
        except FS_ERRORS as exc:
            if never_opened(readers[side], paths[side], exc):
                return _failure(readers[side], paths[side], exc)
            unreadable = unreadable or (side, exc)
    if unreadable is None:
        return b""
    side, error = unreadable
    return _failure(readers[side], paths[side], error)


async def _join_stream(
    stream: OpenStream,
    readers: tuple[AsyncLineIterator, AsyncLineIterator],
    paths: tuple[PathSpec, PathSpec],
    io: IOResult,
) -> AsyncGenerator[bytes, None]:
    """Walk the two inputs through the ``join`` engine; a failed read ends
    the run after what join already printed.

    Args:
        stream (OpenStream): the ``join`` engine.
        readers (tuple[AsyncLineIterator, AsyncLineIterator]): the inputs.
        paths (tuple[PathSpec, PathSpec]): the operands.
        io (IOResult): where the diagnostics and the status land.
    """
    failed: list[int] = []

    async def pull(side: int) -> bytes | None:
        try:
            return await readers[side].read_chunk()
        except FS_ERRORS:
            failed.append(side)
            raise

    error = b""
    try:
        try:
            error = await _open_inputs(readers, paths)
            if not error:
                async with aclosing(merge_output(stream, pull)) as output:
                    async for chunk in output:
                        yield chunk
        except FS_ERRORS as exc:
            side = failed[-1]
            error = _failure(readers[side], paths[side], exc)
    finally:
        io.stderr = stream.take_stderr() + error
        io.exit_code = 1 if error else stream.status()
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
    parsed = parse_flags(
        flags, [_operand_word(path) for path in resolved], ctx.argv
    )
    if isinstance(parsed, IOResult):
        return None, parsed
    return await join(
        resolved, read_stream=read_stream, stdin=ctx.stdin, flags=parsed
    )


__all__ = ["JoinFlags", "join", "join_generic", "parse_flags"]
