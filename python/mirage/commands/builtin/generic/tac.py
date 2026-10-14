import re
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.constants import (
    RANGE_FIRST_BLOCK,
    RANGE_MAX_BLOCK,
)
from mirage.commands.builtin.utils.operands import (
    merge_split_errors,
    normalized_read,
    split_readable,
)
from mirage.commands.builtin.utils.stream import (
    is_stdin,
    resolve_source,
    stdin_stat,
    stdin_stream,
)
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.errors.constants import FS_ERRORS
from mirage.errors.render import fs_error_line
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.shell.bytes import encode_text
from mirage.types import PathSpec, PolymorphicReadFn, ReadRangeFn, StatFn


@dataclass(frozen=True, slots=True)
class TacFlags:
    separator: str = "\n"
    before: bool = False
    regex: bool = False


def parse_flags(flags: Mapping[str, FlagValue]) -> TacFlags:
    fl = FlagView(flags, spec=SPECS["tac"])
    return TacFlags(
        separator=fl.as_str("separator") or "\n",
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


async def _reverse_ranged(
    read_range: ReadRangeFn,
    path: PathSpec,
    size: int,
    separator: bytes,
    before: bool,
) -> AsyncIterator[bytes]:
    """A file's records last first, read from its end a block at a time.

    Only a whole record is let out, so a reader that stops after the
    last lines leaves the rest unread. For a one-byte separator, which
    no record boundary can straddle unseen.

    Args:
        read_range (Callable): the mount's byte window.
        path (PathSpec): the file.
        size (int): its size.
        separator (bytes): the one-byte separator.
        before (bool): -b.
    """
    pos = size
    held = b""
    block = RANGE_FIRST_BLOCK
    while pos > 0:
        start = max(pos - block, 0)
        got = await read_range(path, offset=start, size=pos - start)
        held = bytes(got) + held
        pos = start
        block = min(block * 2, RANGE_MAX_BLOCK)
        at = held.find(separator)
        if pos == 0 or at < 0:
            continue
        cut = at if before else at + 1
        out = b"".join(reversed(_records(held[cut:], separator, before)))
        held = held[:cut]
        if out:
            yield out
    if held:
        yield b"".join(reversed(_records(held, separator, before)))


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


async def _reversed(
    plans: list[tuple[PathSpec, int | AsyncIterator[bytes]]],
    read_range: ReadRangeFn | None,
    separator: str,
    before: bool,
    regex: bool,
    io: IOResult,
) -> AsyncIterator[bytes]:
    """Each operand's records last first, one operand after another.

    An operand that fails to read is reported on ``io`` and the next
    one goes on, as GNU tac does.

    Args:
        plans (list[tuple[PathSpec, int | AsyncIterator[bytes]]]): each
            operand with its size, to read it from its end, or its
            stream, to read it whole.
        read_range (ReadRangeFn | None): the mount's byte window.
        separator (str): -s.
        before (bool): -b.
        regex (bool): -r.
        io (IOResult): takes each failed operand's line.
    """
    for p, plan in plans:
        try:
            if isinstance(plan, int) and read_range is not None:
                async for chunk in _reverse_ranged(
                    read_range, p, plan, encode_text(separator), before
                ):
                    yield chunk
            elif not isinstance(plan, int):
                yield await _reverse_source(plan, separator, before, regex)
        except FS_ERRORS as exc:
            held = await materialize(io.stderr) if io.stderr else b""
            io.stderr = held + encode_text(fs_error_line("tac", p, exc))
            io.exit_code = 1


async def tac(
    paths: list[PathSpec],
    *,
    read_stream: Callable[..., AsyncIterator[bytes]],
    stdin: ByteSource | None = None,
    separator: str = "\n",
    before: bool = False,
    regex: bool = False,
    read_range: ReadRangeFn | None = None,
    size_of: Callable[[PathSpec], Awaitable[int | None]] | None = None,
) -> tuple[ByteSource | None, IOResult]:
    if paths:
        # A file the mount serves ranges for, with a size its stat knows
        # and a one-byte separator, is read from its end; any other is
        # read whole. Each is planned here, while the command runs, and
        # read as the output is pulled.
        ranged = (
            read_range is not None
            and size_of is not None
            and not regex
            and len(encode_text(separator)) == 1
        )
        plans: list[tuple[PathSpec, int | AsyncIterator[bytes]]] = []
        for p in paths:
            size = (
                await size_of(p)
                if ranged and size_of is not None and not is_stdin(p)
                else None
            )
            plans.append((p, size if size is not None else read_stream(p)))
        io = IOResult()
        return _reversed(plans, read_range, separator, before, regex, io), io

    source = resolve_source(stdin)
    return await _reverse_source(source, separator, before, regex), IOResult()


async def tac_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    stat: StatFn,
    stream: PolymorphicReadFn,
    read_range: ReadRangeFn | None = None,
    size_of: Callable[[PathSpec], Awaitable[int | None]] | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Run tac over resolved operands; mirrors tacGeneric.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by tac.
        opts (CommandOpts): Flags and stdin from the dispatcher.
        stat (StatFn): Bound stat called as ``stat(path)``.
        stream (PolymorphicReadFn): Bound reader called as
            ``stream(path)``.
        read_range (Callable | None): the mount's byte window, which
            reads a file from its end.
        size_of (Callable | None): a regular file's size.
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
            read_range=read_range,
            size_of=size_of,
        ),
        err,
    )


__all__ = ["tac", "tac_generic"]
