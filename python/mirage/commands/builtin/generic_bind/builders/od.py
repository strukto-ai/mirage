from mirage.accessor.base import Accessor
from mirage.commands.builtin.generic.od import od_generic as generic_od
from mirage.commands.builtin.generic_bind.adapter import (
    GenericCommand,
    bound_op,
    resolve_or_empty,
)
from mirage.commands.config import CommandIO, Context
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def od(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    paths = await resolve_or_empty(ops, accessor, paths, ctx.index)
    return await generic_od(
        paths,
        ctx,
        read_stream=bound_op(ops.read_stream, accessor, ctx.index),
    )


BUILDER = GenericCommand("od", od, read=True)
