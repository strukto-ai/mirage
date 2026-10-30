import json
from collections.abc import (
    AsyncGenerator,
    Awaitable,
    Callable,
    Mapping,
    Sequence,
)
from contextlib import aclosing
from dataclasses import dataclass
from enum import Enum

from mirage.commands.builtin.utils.stream import (
    is_stdin,
    never_opened,
    stdin_stream,
)
from mirage.commands.config import Context
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.constants import OPERAND, SPELLED
from mirage.commands.spec.flag_view import FlagView, spread_operands
from mirage.commands.spec.types import CommandName, FlagValue
from mirage.commands.spec.usage import (
    missing_operand_error,
)
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import fs_strerror
from mirage.errors.render import fs_error_line
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.stream import OutputStream
from mirage.io.types import ByteSource, IOResult
from mirage.rs.errors import StreamRefusal
from mirage.rs.stream import (
    OpenStream,
    close_stream,
    merge_output,
    open_stream,
)
from mirage.shell.bytes import byte_view, encode_text
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


class OrderCheck(Enum):
    """What join does with a line whose key sorts before the one above it.

    WARN, the default, names the first such line of each file, but only
    once some line has gone unpaired, then finishes and exits 1 under
    ``input is not in sorted order``. FAIL (``--check-order``) names the
    first one and stops there. OFF (``--nocheck-order``) never looks.
    """

    WARN = "warn"
    FAIL = "fail"
    OFF = "off"


@dataclass(frozen=True)
class JoinFlags:
    """join's options as one line set them.

    Attributes:
        keys (tuple[int, int]): each file's join field, counted from 0.
        unpaired (tuple[bool, bool]): whether each file's unpairable lines
            print (``-a``, ``-v``).
        paired (bool): whether joined lines print; any ``-v`` clears it.
        filler (bytes | None): the ``-e`` text for an empty field.
        columns (tuple[tuple[int, int], ...]): the ``-o`` list, each item
            a file number and a field counted from 0; file 0 is the join
            field.
        auto_columns (bool): ``-o auto``.
        delimiter (bytes | None): the ``-t`` byte; None parts fields at
            runs of blanks and WHOLE_RECORD keeps each record whole.
        separator (bytes): what output fields are joined with.
        fold_case (bool): ``-i``.
        terminator (bytes): what ends a record, NUL under ``-z``.
        order (OrderCheck): what an unsorted line does.
        header (bool): ``--header``.
        files (tuple[int, int]): the operand positions of FILE1 and FILE2.
    """

    keys: tuple[int, int] = (0, 0)
    unpaired: tuple[bool, bool] = (False, False)
    paired: bool = True
    filler: bytes | None = None
    columns: tuple[tuple[int, int], ...] = ()
    auto_columns: bool = False
    delimiter: bytes | None = None
    separator: bytes = b" "
    fold_case: bool = False
    terminator: bytes = b"\n"
    order: OrderCheck = OrderCheck.WARN
    header: bool = False
    files: tuple[int, int] = (0, 1)


def _options(
    flags: Mapping[str, FlagValue],
    operands: Sequence[str],
    argv: Sequence[str],
) -> dict[str, JsonValue]:
    tape = FlagView(flags, SPECS[CommandName.JOIN]).occurrences(
        OPERAND, SPELLED, *OPTION_DESTS
    )
    return {
        "options": [
            [
                name,
                byte_view(value)
                if isinstance(value, str)
                else value
                if isinstance(value, (int, bool))
                else str(value),
            ]
            for name, value in tape
        ],
        "operands": [byte_view(word) for word in operands],
        "argv": [byte_view(word) for word in argv],
    }


def _parsed(stream: OpenStream) -> JoinFlags:
    config = json.loads(stream.metadata())
    return JoinFlags(
        keys=tuple(config["keys"]),
        unpaired=tuple(config["unpaired"]),
        paired=config["paired"],
        filler=None if config["filler"] is None else bytes(config["filler"]),
        columns=tuple(tuple(column) for column in config["columns"]),
        auto_columns=config["auto_columns"],
        delimiter=None
        if config["delimiter"] is None
        else bytes(config["delimiter"]),
        separator=bytes(config["separator"]),
        fold_case=config["fold_case"],
        terminator=b"\0" if config["zero_terminated"] else b"\n",
        order=OrderCheck(config["order"]),
        header=config["header"],
        files=tuple(config["files"]),
    )


def parse_flags(
    flags: Mapping[str, FlagValue],
    operands: Sequence[str] = (),
    argv: Sequence[str] = (),
) -> JoinFlags:
    try:
        return _parsed(open_stream("join", _options(flags, operands, argv)))
    except StreamRefusal as exc:
        raise UsageError(exc.message, 1) from exc


def _operand_word(path: PathSpec) -> str:
    return path.raw_path


async def join(
    paths: list[PathSpec],
    *,
    read_stream: PolymorphicReadFn,
    stdin: ByteSource | None = None,
    flags: JoinFlags = JoinFlags(),
    engine: OpenStream | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """GNU ``join`` of two files over already-parsed options.

    Args:
        paths (list[PathSpec]): the operands, of which ``flags.files``
            names the two files; ``-`` reads stdin.
        read_stream (PolymorphicReadFn): reads one operand's bytes.
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
    read = stdin_stream(read_stream, stdin)
    readers = (AsyncLineIterator(read(file1)), AsyncLineIterator(read(file2)))
    names = (_operand_word(file1), _operand_word(file2))
    stream = engine or open_stream(
        "join",
        {
            "keys": list(flags.keys),
            "unpaired": list(flags.unpaired),
            "paired": flags.paired,
            "filler": None
            if flags.filler is None
            else byte_view(flags.filler),
            "columns": [list(column) for column in flags.columns],
            "auto_columns": flags.auto_columns,
            "delimiter": (
                None if flags.delimiter is None else byte_view(flags.delimiter)
            ),
            "separator": byte_view(flags.separator),
            "fold_case": flags.fold_case,
            "zero_terminated": flags.terminator == b"\0",
            "order": flags.order.value,
            "header": flags.header,
            "names": [byte_view(name) for name in names],
        },
    )
    io = IOResult()

    async def close() -> None:
        await close_stream(stream)
        for reader in readers:
            await reader.discard()

    return OutputStream(
        _join_stream(stream, readers, (file1, file2), io), close
    ), io


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
        await close_stream(stream)
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
    try:
        engine = open_stream(
            "join",
            _options(
                flags, [_operand_word(path) for path in resolved], ctx.argv
            ),
        )
    except StreamRefusal as exc:
        raise UsageError(exc.message, 1) from exc
    try:
        result = await join(
            resolved,
            read_stream=read_stream,
            stdin=ctx.stdin,
            flags=_parsed(engine),
            engine=engine,
        )
        if result[0] is None:
            await close_stream(engine)
        return result
    except BaseException:
        await close_stream(engine)
        raise


__all__ = ["JoinFlags", "OrderCheck", "join", "join_generic", "parse_flags"]
