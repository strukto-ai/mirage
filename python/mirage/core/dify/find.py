import fnmatch

from mirage.cache.index import IndexCacheStore
from mirage.core.dify.path import resolve_path
from mirage.core.dify.stat import stat
from mirage.core.dify.walk import walk
from mirage.types import FindType, PathSpec


async def find(
    accessor,
    path: PathSpec,
    name: str | None = None,
    type: str | None = None,
    min_size: int | None = None,
    max_size: int | None = None,
    maxdepth: int | None = None,
    name_exclude: str | None = None,
    or_names: list[str] | None = None,
    mtime_min: float | None = None,
    mtime_max: float | None = None,
    iname: str | None = None,
    path_pattern: str | None = None,
    mindepth: int | None = None,
    index: IndexCacheStore | None = None,
) -> list[str]:
    if index is None:
        raise ValueError("find: missing index")
    results = await walk(accessor,
                         path,
                         index,
                         include_root=True,
                         maxdepth=maxdepth,
                         strip_prefix=True)
    filtered: list[str] = []
    for item in results:
        if await _matches(accessor, item, path.prefix, index,
                          path.strip_prefix, name, type, min_size, max_size,
                          name_exclude, or_names, iname, path_pattern,
                          mindepth):
            filtered.append(item)
    return sorted(filtered)


async def _matches(
    accessor,
    item: str,
    prefix: str,
    index: IndexCacheStore,
    root: str,
    name: str | None,
    type: str | None,
    min_size: int | None,
    max_size: int | None,
    name_exclude: str | None,
    or_names: list[str] | None,
    iname: str | None,
    path_pattern: str | None,
    mindepth: int | None,
) -> bool:
    item_name = item.rstrip("/").rsplit("/", 1)[-1]
    if mindepth is not None and _relative_depth(item, root) < mindepth:
        return False
    if name and not fnmatch.fnmatch(item_name, name):
        return False
    if iname and not fnmatch.fnmatch(item_name.lower(), iname.lower()):
        return False
    if path_pattern and not fnmatch.fnmatch(item, path_pattern):
        return False
    if name_exclude and fnmatch.fnmatch(item_name, name_exclude):
        return False
    if or_names and not any(
            fnmatch.fnmatch(item_name, pattern) for pattern in or_names):
        return False
    spec = PathSpec.from_str_path(item, prefix)
    if type is not None:
        resolved = await resolve_path(accessor, spec, index)
        if type == FindType.FILE and resolved.is_dir:
            return False
        if type == FindType.DIRECTORY and not resolved.is_dir:
            return False
    if min_size is not None or max_size is not None:
        item_stat = await stat(accessor, spec, index)
        if item_stat.size is None:
            return False
        if min_size is not None and item_stat.size < min_size:
            return False
        if max_size is not None and item_stat.size > max_size:
            return False
    return True


def _relative_depth(item: str, root: str) -> int:
    root_norm = root.rstrip("/") or "/"
    item_norm = item.rstrip("/") or "/"
    if item_norm == root_norm:
        return 0
    if root_norm == "/":
        relative = item_norm.strip("/")
    else:
        relative = item_norm.removeprefix(root_norm).lstrip("/")
    if not relative:
        return 0
    return relative.count("/") + 1
