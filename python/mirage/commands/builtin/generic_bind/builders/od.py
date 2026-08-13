from mirage.accessor.base import Accessor
from mirage.commands.builtin.generic.od import od as generic_od
from mirage.commands.builtin.generic.od import parse_count
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          bound_op)
from mirage.commands.builtin.generic_bind.builders.common import \
    resolve_or_empty
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def od(ops: CommandIO, accessor: Accessor, paths: list[PathSpec],
             texts: list[str],
             opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(opts.flags, spec=SPECS["od"])
    paths = await resolve_or_empty(ops, accessor, paths, opts.index)
    formats = fl.as_list("format")
    # as_str, not `x or y`: the latter would swallow an explicitly empty
    # value, which GNU rejects loudly (`od -N ''` is an invalid argument,
    # not an absent flag).
    skip_value = fl.as_str("skip_bytes")
    limit_value = fl.as_str("read_bytes")
    return await generic_od(
        paths,
        read_stream=bound_op(ops.read_stream, accessor, opts.index),
        stdin=opts.stdin,
        address_radix=fl.as_str("address_radix") or "o",
        skip=(parse_count(skip_value, "-j") if skip_value is not None else 0),
        limit=(parse_count(limit_value, "-N")
               if limit_value is not None else None),
        formats=formats,
    )


BUILDER = Builder("od", od, read=True)
