import fnmatch
import posixpath

from mirage.accessor.sharepoint import SharePointAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.sharepoint.readdir import readdir
from mirage.types import PathSpec


async def resolve_glob(
    accessor: SharePointAccessor,
    paths: list[PathSpec],
    index: IndexCacheStore,
) -> list[PathSpec]:
    result: list[PathSpec] = []
    for p in paths:
        if isinstance(p, str):
            result.append(PathSpec(original=p, directory=posixpath.dirname(p)))
            continue
        if p.resolved:
            result.append(p)
        elif p.pattern:
            entries = await readdir(accessor, p.dir, index)
            matched = [
                PathSpec.from_str_path(e, p.prefix) for e in entries
                if fnmatch.fnmatch(e.rsplit("/", 1)[-1], p.pattern)
            ]
            result.extend(matched)
        else:
            result.append(p)
    return result
