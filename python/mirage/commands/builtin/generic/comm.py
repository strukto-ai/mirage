from collections.abc import AsyncGenerator, AsyncIterator, Mapping
from contextlib import aclosing
from dataclasses import dataclass

from mirage.commands.builtin.utils.lines import record_separator
from mirage.commands.builtin.utils.operands import normalized_read
from mirage.commands.builtin.utils.stream import is_stdin, resolve_source
from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import CommandName, FlagValue
from mirage.commands.spec.usage import (
    extra_operand_error,
    missing_operand_error,
)
from mirage.errors.constants import FS_ERRORS
from mirage.errors.render import fs_error_line
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.cooperative import chunks
from mirage.io.types import ByteSource, IOResult
from mirage.io.yield_budget import YieldBudget
from mirage.rs.stream import close_stream, open_stream
from mirage.shell.bytes import byte_view
from mirage.types import PathSpec, PolymorphicReadFn


async def comm(
    paths: list[PathSpec],
    *,
    read_stream: PolymorphicReadFn,
    stdin: ByteSource | None = None,
    suppress1: bool = False,
    suppress2: bool = False,
    suppress3: bool = False,
    check_order: bool | None = None,
    output_delimiter: str = "\t",
    total: bool = False,
    zero_terminated: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    if len(paths) > 2:
        raise extra_operand_error(
            CommandName.COMM, paths[2].raw_path or paths[2].virtual
        )
    if len(paths) < 2:
        raise missing_operand_error(
            CommandName.COMM,
            paths[-1].raw_path or paths[-1].virtual if paths else None,
        )
    read = normalized_read(read_stream)
    shared = AsyncLineIterator(resolve_source(stdin))
    readers = [
        shared if is_stdin(p) else AsyncLineIterator(read(p)) for p in paths
    ]
    io = IOResult()
    return _comm_stream(
        readers,
        io,
        (suppress1, suppress2, suppress3),
        check_order,
        output_delimiter,
        total,
        record_separator(zero_terminated),
        paths,
    ), io


async def _comm_stream(
    readers: list[AsyncLineIterator],
    io: IOResult,
    suppressed: tuple[bool, bool, bool],
    check_order: bool | None,
    delimiter: str,
    total: bool,
    separator: bytes,
    paths: list[PathSpec],
) -> AsyncIterator[bytes]:
    stream = open_stream(
        "comm",
        {
            "suppressed": list(suppressed),
            "check_order": check_order,
            "delimiter": byte_view(delimiter),
            "total": total,
            "terminator": separator[0],
        },
    )
    sources = [_comm_chunks(reader, separator) for reader in readers]
    budget = YieldBudget()
    errors = bytearray()

    def record_result() -> None:
        errors.extend(stream.take_stderr())
        io.stderr = bytes(errors)
        io.exit_code = max(io.exit_code, stream.status())

    try:
        while True:
            await budget.run()
            if stream.busy():
                output = stream.drain()
            elif (which := stream.wants()) is not None:
                try:
                    chunk = await anext(sources[which])
                except StopAsyncIteration:
                    output = stream.end_input(which)
                except FS_ERRORS as exc:
                    errors.extend(
                        fs_error_line("comm", paths[which], exc).encode()
                    )
                    io.stderr, io.exit_code = bytes(errors), 1
                    return
                else:
                    output = stream.feed_input(which, chunk)
            else:
                break
            record_result()
            if output:
                yield output
        if not stream.done() and all(path.raw_path == "-" for path in paths):
            errors.extend(b"comm: -: Bad file descriptor\n")
            io.stderr, io.exit_code = bytes(errors), 1
            return
        output = stream.finish()
        record_result()
        if output:
            yield output
        while stream.busy():
            await budget.run()
            output = stream.drain()
            record_result()
            if output:
                yield output
    finally:
        record_result()
        await close_stream(stream)
        for source in sources:
            await source.aclose()
        for reader in dict.fromkeys(readers):
            await reader.discard()


async def _comm_chunks(
    reader: AsyncLineIterator, separator: bytes
) -> AsyncGenerator[bytes, None]:
    while (record := await reader.readline(separator)) is not None:
        async with aclosing(chunks(record)) as source:
            async for piece in source:
                yield piece
        yield separator


__all__ = ["comm"]


@dataclass(frozen=True, slots=True)
class CommFlags:
    """comm's options; ``check_order`` is the later of --check-order and
    --nocheck-order, None when neither was given."""

    suppress1: bool = False
    suppress2: bool = False
    suppress3: bool = False
    check_order: bool | None = None
    output_delimiter: str = "\t"
    total: bool = False
    zero_terminated: bool = False


def parse_flags(flags: Mapping[str, FlagValue]) -> CommFlags:
    fl = FlagView(flags, spec=SPECS["comm"])
    # An empty delimiter is its own terminating NUL: GNU writes one byte.
    delimiter = fl.as_str("output_delimiter", "\t") or "\0"
    order = [
        name
        for name, value in fl.occurrences("check_order", "nocheck_order")
        if value
    ]
    return CommFlags(
        suppress1=fl.as_bool("args_1"),
        suppress2=fl.as_bool("2"),
        suppress3=fl.as_bool("3"),
        check_order=order[-1] == "check_order" if order else None,
        output_delimiter=delimiter,
        total=fl.as_bool("total"),
        zero_terminated=fl.as_bool("zero_terminated"),
    )


async def comm_generic(
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    read_stream: PolymorphicReadFn,
) -> tuple[ByteSource | None, IOResult]:
    parsed = parse_flags(ctx.flags)
    return await comm(
        paths,
        read_stream=read_stream,
        stdin=ctx.stdin,
        suppress1=parsed.suppress1,
        suppress2=parsed.suppress2,
        suppress3=parsed.suppress3,
        check_order=parsed.check_order,
        output_delimiter=parsed.output_delimiter,
        total=parsed.total,
        zero_terminated=parsed.zero_terminated,
    )
