from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.stat import stat as generic_stat
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.dify.glob import resolve_glob
from mirage.core.dify.stat import stat as stat_core
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("stat", resource="dify", spec=SPECS["stat"])
async def stat(
    accessor,
    paths: list[PathSpec],
    *texts: str,
    c: str | None = None,
    f: str | None = None,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    paths = await resolve_glob(accessor, paths, index)
    return await generic_stat(paths,
                              stat_fn=stat_core,
                              accessor=accessor,
                              index=index,
                              c=c,
                              f=f)
