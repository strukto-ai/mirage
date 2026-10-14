import re
from collections.abc import AsyncIterator, Callable, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.utils.operands import (
    merge_split_errors,
    normalized_read,
    operands_io,
    read_operands,
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
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
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


def _records(data: bytes, separator: bytes, before: bool) -> list[bytes]:
    """``data`` cut into tac's records, in file order.

    A record ends with the separator, or with ``before`` (``-b``) starts
    with it; the text before the first separator, or after the last, is
    a record without one.

    Args:
        data (bytes): the bytes to cut.
        separator (bytes): the separator.
        before (bool): -b.
    """
    texts = data.split(separator)
    if before:
        records = [texts[0], *(separator + text for text in texts[1:])]
    else:
        records = [text + separator for text in texts[:-1]] + [texts[-1]]
    return [record for record in records if record]


async def _reverse_source(
    source: AsyncIterator[bytes], separator: str, before: bool, regex: bool
) -> bytes:
    data = b"".join([chunk async for chunk in source])
    if not regex:
        return b"".join(
            reversed(_records(data, encode_text(separator), before))
        )
    text = data.decode(errors="replace")
    parts = re.split(f"({separator})", text)
    records: list[str] = []
    for index in range(0, len(parts) - 1, 2):
        records.append(
            parts[index + 1] + parts[index]
            if before
            else parts[index] + parts[index + 1]
        )
    if len(parts) % 2 == 1 and parts[-1]:
        records.append(parts[-1])
    records.reverse()
    return "".join(records).encode()


async def tac(
    paths: list[PathSpec],
    *,
    read_stream: Callable[..., AsyncIterator[bytes]],
    stdin: ByteSource | None = None,
    separator: str = "\n",
    before: bool = False,
    regex: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    if paths:
        ok, err = await read_operands(paths, read_stream, "tac")
        parts: list[bytes] = []
        for operand in ok:
            parts.append(
                await _reverse_source(
                    yield_bytes(operand.data), separator, before, regex
                )
            )
        return b"".join(parts), operands_io(err)

    source = resolve_source(stdin)
    return await _reverse_source(source, separator, before, regex), IOResult()


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
