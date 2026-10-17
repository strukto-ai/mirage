from functools import partial

from mirage.accessor.base import Accessor
from mirage.commands.builtin.generic.truncate import parse_flags
from mirage.commands.builtin.generic.truncate import (
    truncate_generic as generic_truncate,
)
from mirage.commands.builtin.generic_bind.adapter import (
    GenericCommand,
    Operation,
    bound_op,
    require_op,
)
from mirage.commands.config import CommandIO, Context
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def truncate(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    flags = parse_flags(ctx.flags)
    truncate_fn = require_op(ops, Operation.TRUNCATE)
    paths = await ops.resolve_glob(accessor, paths, ctx.index)
    return await generic_truncate(
        paths,
        flags=flags,
        stat=bound_op(ops.stat, accessor, ctx.index),
        truncate_fn=partial(truncate_fn, accessor),
    )


BUILDER = GenericCommand("truncate", truncate, write=True)
