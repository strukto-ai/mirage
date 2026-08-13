from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.cat import cat_generic
from mirage.commands.builtin.generic_bind import CommandIO
from mirage.commands.builtin.generic_bind.adapter import (bound_op,
                                                          dir_aware_stat)
from mirage.commands.builtin.generic_bind.builders.common import \
    resolve_or_empty
from mirage.commands.config import CommandOpts
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def make_cat(ops: CommandIO):
    """Build dify ``cat`` over cache-aware readers.

    Args:
        ops (CommandIO): the dify IO adapter whose ``read_bytes`` /
            ``read_stream`` already serve cached bytes when warm.
    """

    @command("cat", resource="dify", spec=SPECS["cat"])
    async def cat(
        accessor,
        paths: list[PathSpec],
        *texts: str,
        stdin: ByteSource | None = None,
        index: IndexCacheStore,
        **flags: FlagValue,
    ) -> tuple[ByteSource | None, IOResult]:
        resolved = await resolve_or_empty(ops, accessor, paths, index)
        return await cat_generic(resolved,
                                 list(texts),
                                 CommandOpts(stdin=stdin, flags=flags),
                                 dir_aware_stat(ops, accessor, index),
                                 bound_op(ops.read_stream, accessor, index),
                                 local=ops.local)

    return cat
