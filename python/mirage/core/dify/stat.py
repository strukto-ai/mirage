from mirage.accessor.dify import DifyAccessor
from mirage.core.slug_tree.stat import tree_stat
from mirage.types import FileStat, PathSpec


async def stat(
    accessor: DifyAccessor, path: PathSpec, entry: FileStat | None = None
) -> FileStat:
    return tree_stat(path, entry)
