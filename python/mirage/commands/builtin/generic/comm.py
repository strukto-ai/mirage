from collections.abc import AsyncIterator, Mapping
from contextlib import aclosing
from dataclasses import dataclass

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
from mirage.io.types import ByteSource, IOResult
from mirage.rs.stream import OpenStream, merge_output, open_stream
from mirage.shell.bytes import byte_view, encode_text
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
    stream = open_stream(
        "comm",
        {
            "suppress": [suppress1, suppress2, suppress3],
            "check_order": check_order,
            "delimiter": byte_view(output_delimiter),
            "total": total,
            "zero_terminated": zero_terminated,
            "shared": readers[0] is readers[1],
            "stdin_twice": all(p.raw_path == "-" for p in paths),
        },
    )
    io = IOResult()
    return _comm_stream(stream, readers, io, paths), io


async def _comm_stream(
    stream: OpenStream,
    readers: list[AsyncLineIterator],
    io: IOResult,
    paths: list[PathSpec],
) -> AsyncIterator[bytes]:
    """Run comm's merge over the two inputs; a failed read ends the run,
    named for its operand after what comm already printed to stderr.

    Args:
        stream (OpenStream): the ``comm`` engine.
        readers (list[AsyncLineIterator]): file 1 and file 2, one reader
            when both are stdin.
        io (IOResult): where the warnings and the status land.
        paths (list[PathSpec]): file 1 and file 2, as typed.
    """
    failed: list[int] = []

    async def pull(which: int) -> bytes | None:
        try:
            return await readers[which].read_chunk()
        except FS_ERRORS:
            failed.append(which)
            raise

    error = b""
    try:
        try:
            async with aclosing(merge_output(stream, pull)) as output:
                async for chunk in output:
                    yield chunk
        except FS_ERRORS as exc:
            error = encode_text(fs_error_line("comm", paths[failed[-1]], exc))
    finally:
        io.stderr = stream.take_stderr() + error or None
        io.exit_code = 1 if error else stream.status()
        for reader in dict.fromkeys(readers):
            await reader.discard()


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
