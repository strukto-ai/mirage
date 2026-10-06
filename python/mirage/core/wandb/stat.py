from mirage.accessor.wandb import WandbAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore, RAMIndexCacheStore
from mirage.core.hierarchy.probe import assert_listed, resolve_entry
from mirage.core.wandb.pathing import parts
from mirage.core.wandb.readdir import readdir
from mirage.errors.fs import enoent
from mirage.types import ContentType, FileStat, FileType, PathSpec


async def stat(
    accessor: WandbAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> FileStat:
    ps = parts(accessor, path)
    if not ps:
        return FileStat(name="/", type=FileType.DIRECTORY, size=0)
    if index is NULL_INDEX or index is None:
        index = RAMIndexCacheStore()
    await assert_listed(readdir, accessor, path, index)
    found = await resolve_entry(readdir, accessor, path, index)
    if found is None:
        raise enoent(path)
    directory = found.resource_type == "wandb/directory"
    content = None
    if not directory:
        if len(ps) > 4:
            content = ContentType.BINARY
        elif ps[-1].endswith(".json"):
            content = ContentType.JSON
        else:
            content = ContentType.TEXT
    return FileStat(
        name=ps[-1],
        type=FileType.DIRECTORY if directory else FileType.FILE,
        size=found.size,
        content=content,
    )
