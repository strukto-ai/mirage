import re
from collections.abc import AsyncIterator, Callable, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.utils.operands import (
    merge_split_errors,
    normalized_read,
    reported_stream,
    split_readable,
)
from mirage.commands.builtin.utils.stream import (
    resolve_source,
    stdin_stat,
    stdin_stream,
)
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.cooperative import CHUNK_SIZE
from mirage.io.record_spool import RecordSpool, delimited
from mirage.io.stream import OutputStream, async_chain, rechunk
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.shell.bytes import encode_text
from mirage.types import PathSpec, PolymorphicReadFn, StatFn


@dataclass(frozen=True, slots=True)
class TacFlags:
    separator: str = "\n"
    before: bool = False
    regex: bool = False


def _separator_of(raw: str | None) -> str:
    """``-s`` as tac reads it: a newline when absent, and NUL when empty,
    as the C string's terminator.

    Args:
        raw (str | None): as typed.
    """
    if raw is None:
        return "\n"
    return raw or "\0"


def parse_flags(flags: Mapping[str, FlagValue]) -> TacFlags:
    fl = FlagView(flags, spec=SPECS["tac"])
    return TacFlags(
        separator=_separator_of(fl.as_str("separator")),
        before=fl.as_bool("before"),
        regex=fl.as_bool("regex"),
    )


def _reverse_source(
    source: ByteSource, separator: str, before: bool, regex: bool
) -> OutputStream:
    return rechunk(
        _reversed_regex(source, separator, before)
        if regex
        else _reversed(source, encode_text(separator), before),
        CHUNK_SIZE,
    )


async def _reversed(
    source: ByteSource, separator: bytes, before: bool
) -> AsyncIterator[bytes]:
    if len(separator) == 1:
        records = await delimited([source], separator)
    else:
        records = RecordSpool()
        reader = AsyncLineIterator(source)
        try:
            while True:
                raw, found = await reader.read_until(separator)
                if raw or found:
                    await records.append(raw + (separator if found else b""))
                if not found:
                    break
        except BaseException:
            await records.close()
            raise
        finally:
            await reader.discard()
    async with records:
        for index in range(records.count - 1, -1, -1):
            offset, size = await records.window(index)
            if before:
                ended = size >= len(separator) and (
                    await records.data.read(
                        offset + size - len(separator), len(separator)
                    )
                    == separator
                )
                if ended:
                    size -= len(separator)
                    if index == records.count - 1:
                        yield separator
                if index:
                    yield separator
            async for part in records.data.stream(offset, size):
                yield part


async def _reversed_regex(
    source: ByteSource, separator: str, before: bool
) -> AsyncIterator[bytes]:
    text = (await materialize(source)).decode(errors="replace")
    parts = re.split(f"({separator})", text)
    pieces: list[str] = []
    for index in range(0, len(parts) - 1, 2):
        pieces.append(
            parts[index + 1] + parts[index]
            if before
            else parts[index] + parts[index + 1]
        )
    if len(parts) % 2 == 1 and parts[-1]:
        pieces.append(parts[-1])
    pieces.reverse()
    yield "".join(pieces).encode()


async def tac(
    paths: list[PathSpec],
    *,
    read_stream: Callable[..., AsyncIterator[bytes]],
    stdin: ByteSource | None = None,
    separator: str = "\n",
    before: bool = False,
    regex: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    io = IOResult()
    if paths:
        return async_chain(
            [
                reported_stream(
                    _reverse_source(
                        read_stream(path), separator, before, regex
                    ),
                    io,
                    path,
                    "tac",
                )
                for path in paths
            ]
        ), io
    return _reverse_source(resolve_source(stdin), separator, before, regex), io


async def tac_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    stat: StatFn,
    stream: PolymorphicReadFn,
) -> tuple[ByteSource | None, IOResult]:
    """Run tac over resolved operands; mirrors tacGeneric.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by tac.
        opts (CommandOpts): Flags and stdin from the dispatcher.
        stat (StatFn): Bound stat called as ``stat(path)``.
        stream (PolymorphicReadFn): Bound reader called as
            ``stream(path)``.
    """
    stat = stdin_stat(stat)
    stream = stdin_stream(stream, opts.stdin)
    parsed = parse_flags(opts.flags)
    readable, err = await split_readable(paths, stat, "tac")
    if err and not readable:
        return None, IOResult(exit_code=1, stderr=err)
    return await merge_split_errors(
        await tac(
            readable,
            read_stream=normalized_read(stream),
            stdin=opts.stdin,
            separator=parsed.separator,
            before=parsed.before,
            regex=parsed.regex,
        ),
        err,
    )


__all__ = ["tac", "tac_generic"]
