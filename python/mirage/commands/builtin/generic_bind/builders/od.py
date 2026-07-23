from mirage.accessor.base import Accessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.generic.od import od as generic_od
from mirage.commands.builtin.generic.od import parse_count
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          bound_op)
from mirage.commands.builtin.generic_bind.builders.common import \
    resolve_or_empty
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def od(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: ByteSource | None = None,
    A: str | None = None,
    j: str | None = None,
    N: str | None = None,
    t: str | list[str] | None = None,
    index: IndexCacheStore = NULL_INDEX,
    **flags: object,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(flags, spec=SPECS["od"])
    paths = await resolve_or_empty(ops, accessor, paths, index)
    formats = ([t] if isinstance(t, str) else t) or fl.as_list("format")
    limit_value = N or fl.as_str("read_bytes")
    return await generic_od(
        paths,
        read_stream=bound_op(ops.read_stream, accessor, index),
        stdin=stdin,
        address_radix=A or fl.as_str("address_radix") or "o",
        skip=parse_count(j or fl.as_str("skip_bytes") or "0"),
        limit=parse_count(limit_value) if limit_value is not None else None,
        formats=formats,
    )


BUILDER = Builder("od", od, read=True)
