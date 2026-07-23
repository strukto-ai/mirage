from functools import partial

from mirage.accessor.base import Accessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.generic.truncate import \
    truncate as generic_truncate
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          Operation, bound_op)
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def truncate(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: ByteSource | None = None,
    s: str | None = None,
    index: IndexCacheStore = NULL_INDEX,
    **flags: object,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(flags, spec=SPECS["truncate"])
    size = s or fl.as_str("size")
    if size is None:
        raise ValueError("truncate: you must specify either '--size' or '-s'")
    truncate_fn = ops.require(Operation.TRUNCATE)
    paths = await ops.resolve_glob(accessor, paths, index)
    return await generic_truncate(
        paths,
        size=size,
        stat=bound_op(ops.stat, accessor, index),
        truncate_fn=partial(truncate_fn, accessor),
    )


BUILDER = Builder("truncate",
                  truncate,
                  write=True,
                  requirements=frozenset({Operation.TRUNCATE}))
