from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.utils.operands import (
    normalized_read,
    reported_stream,
)
from mirage.commands.builtin.utils.stream import resolve_source
from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import CommandName, FlagValue
from mirage.commands.spec.usage import extra_operand_error
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec, PolymorphicReadFn


async def look(
    paths: list[PathSpec],
    prefix: str,
    *,
    read_stream: PolymorphicReadFn,
    stdin: ByteSource | None = None,
    fold_case: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    if len(paths) > 1:
        raise extra_operand_error(
            CommandName.LOOK, paths[1].raw_path or paths[1].virtual
        )
    io = IOResult(exit_code=1)
    source = (
        normalized_read(read_stream)(paths[0])
        if paths
        else resolve_source(stdin)
    )
    output = _look_stream(source, prefix, fold_case, io)
    return (
        reported_stream(output, io, paths[0], "look") if paths else output
    ), io


async def _look_stream(
    source: ByteSource, prefix: str, fold_case: bool, io: IOResult
) -> AsyncIterator[bytes]:
    cmp_prefix = prefix.lower() if fold_case else prefix
    reader = AsyncLineIterator(source)
    try:
        async for raw in reader:
            line = raw.decode(errors="replace")
            cmp_line = line.lower() if fold_case else line
            if cmp_line.startswith(cmp_prefix):
                io.exit_code = 0
                yield (line + "\n").encode()
    finally:
        await reader.discard()


__all__ = ["look"]


@dataclass(frozen=True, slots=True)
class LookFlags:
    fold_case: bool = False


def parse_flags(flags: Mapping[str, FlagValue]) -> LookFlags:
    fl = FlagView(flags, spec=SPECS["look"])
    return LookFlags(fold_case=fl.as_bool("f"))


async def look_generic(
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    read_stream: PolymorphicReadFn,
) -> tuple[ByteSource | None, IOResult]:
    if not texts:
        raise ValueError("look: missing prefix")
    parsed = parse_flags(ctx.flags)
    return await look(
        paths,
        texts[0],
        read_stream=read_stream,
        stdin=ctx.stdin,
        fold_case=parsed.fold_case,
    )
