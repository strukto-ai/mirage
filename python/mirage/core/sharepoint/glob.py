import fnmatch
import posixpath

from mirage.accessor.sharepoint import SharePointAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.sharepoint.readdir import readdir
from mirage.types import PathSpec
from mirage.utils.key_prefix import rekey


async def resolve_glob(
    accessor: SharePointAccessor,
    paths: list[PathSpec],
    index: IndexCacheStore,
) -> list[PathSpec]:
    result: list[PathSpec] = []
    for p in paths:
        if isinstance(p, str):
            result.append(
                PathSpec(resource_path=(p).strip("/"),
                         virtual=p,
                         directory=posixpath.dirname(p)))
            continue
        if p.resolved:
            result.append(p)
        elif p.pattern:
            entries = await readdir(accessor, p.dir, index)
            matched = [
                PathSpec.from_str_path(e, rekey(p.virtual, p.resource_path, e))
                for e in entries
                if fnmatch.fnmatch(e.rsplit("/", 1)[-1], p.pattern)
            ]
            result.extend(matched)
        else:
            result.append(p)
    return result
