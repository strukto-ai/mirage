from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.chroma.path import resolve_path
from mirage.core.chroma.readdir import readdir
from mirage.types import PathSpec
from mirage.utils.key_prefix import rekey


async def walk(
    accessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
    *,
    include_root: bool = False,
    maxdepth: int | None = None,
    strip_prefix: bool = False,
    ignore_missing: bool = False,
    depth: int = 0,
) -> list[str]:
    try:
        resolved = await resolve_path(accessor, path, index)
    except (FileNotFoundError, NotADirectoryError):
        if ignore_missing:
            return []
        raise

    current = path.mount_path if strip_prefix else path.virtual
    results = [current] if include_root else []
    if not resolved.is_dir or (maxdepth is not None and depth >= maxdepth):
        return results

    try:
        children = await readdir(accessor, path, index)
    except (FileNotFoundError, NotADirectoryError):
        if ignore_missing:
            return results
        raise

    for child in children:
        child_path = PathSpec.from_str_path(
            child, rekey(path.virtual, path.resource_path, child))
        results.extend(await walk(accessor,
                                  child_path,
                                  index,
                                  include_root=True,
                                  maxdepth=maxdepth,
                                  strip_prefix=strip_prefix,
                                  ignore_missing=ignore_missing,
                                  depth=depth + 1))
    return results
