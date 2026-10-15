from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.utils.stream import stdin_stream
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import CommandName, FlagValue
from mirage.commands.spec.usage import (
    extra_operand_error,
    missing_operand_error,
)
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec, PolymorphicReadFn


async def comm(
    paths: list[PathSpec],
    *,
    read_stream: PolymorphicReadFn,
    stdin: ByteSource | None = None,
    suppress1: bool = False,
    suppress2: bool = False,
    suppress3: bool = False,
    check_order: bool = False,
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
    read = stdin_stream(read_stream, stdin)
    readers = [AsyncLineIterator(read(p)) for p in paths]
    io = IOResult()
    return _comm_stream(
        readers,
        io,
        (suppress1, suppress2, suppress3),
        check_order,
        output_delimiter,
        total,
        b"\0" if zero_terminated else b"\n",
    ), io


async def _comm_stream(
    readers: list[AsyncLineIterator],
    io: IOResult,
    suppressed: tuple[bool, bool, bool],
    check_order: bool,
    delimiter: str,
    total: bool,
    separator: bytes,
) -> AsyncIterator[bytes]:
    previous: list[str | None] = [None, None]
    warned = [False, False]
    counts = [0, 0, 0]

    async def read(which: int) -> str | None:
        raw = await readers[which].readline(separator)
        line = None if raw is None else raw.decode(errors="replace")
        before = previous[which]
        if (
            check_order
            and line is not None
            and before is not None
            and line < before
        ):
            warned[which] = True
            which_file = 1 if warned[0] else 2
            io.stderr = (
                f"comm: file {which_file} is not in sorted order\n".encode()
            )
            io.exit_code = 1
        previous[which] = line
        return line

    try:
        left, right = await read(0), await read(1)
        while left is not None or right is not None:
            column = (
                1
                if right is None or (left is not None and left < right)
                else 2
                if left is None or right < left
                else 3
            )
            text = left if column != 2 else right
            counts[column - 1] += 1
            if not suppressed[column - 1]:
                yield (
                    delimiter
                    * sum(not value for value in suppressed[: column - 1])
                    + (text or "")
                ).encode() + separator
            if column != 2:
                left = await read(0)
            if column != 1:
                right = await read(1)
        if total:
            yield (
                delimiter.join(
                    [
                        str(count)
                        for count, hidden in zip(counts, suppressed)
                        if not hidden
                    ]
                    + ["total"]
                ).encode()
                + separator
            )
    finally:
        for reader in readers:
            await reader.discard()


__all__ = ["comm"]


@dataclass(frozen=True, slots=True)
class CommFlags:
    suppress1: bool = False
    suppress2: bool = False
    suppress3: bool = False
    check_order: bool = False
    output_delimiter: str = "\t"
    total: bool = False
    zero_terminated: bool = False


def parse_flags(flags: Mapping[str, FlagValue]) -> CommFlags:
    fl = FlagView(flags, spec=SPECS["comm"])
    return CommFlags(
        suppress1=fl.as_bool("args_1"),
        suppress2=fl.as_bool("2"),
        suppress3=fl.as_bool("3"),
        check_order=fl.as_bool("check_order"),
        output_delimiter=fl.as_str("output_delimiter") or "\t",
        total=fl.as_bool("total"),
        zero_terminated=fl.as_bool("zero_terminated"),
    )


async def comm_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    read_stream: PolymorphicReadFn,
) -> tuple[ByteSource | None, IOResult]:
    parsed = parse_flags(opts.flags)
    return await comm(
        paths,
        read_stream=read_stream,
        stdin=opts.stdin,
        suppress1=parsed.suppress1,
        suppress2=parsed.suppress2,
        suppress3=parsed.suppress3,
        check_order=parsed.check_order,
        output_delimiter=parsed.output_delimiter,
        total=parsed.total,
        zero_terminated=parsed.zero_terminated,
    )
