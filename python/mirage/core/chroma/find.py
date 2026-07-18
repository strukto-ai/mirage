from mirage.accessor.chroma import ChromaAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.find_eval import (FindEntry, PredNode, build_tree,
                                               keep, start_basename,
                                               tree_has_empty, tree_has_type)
from mirage.core.chroma.path import resolve_path
from mirage.core.chroma.stat import stat
from mirage.core.chroma.walk import walk
from mirage.types import PathSpec
from mirage.utils.dates import matches_mtime
from mirage.utils.key_prefix import mount_key, mount_prefix_of


async def find(
    accessor: ChromaAccessor,
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
    empty: bool = False,
    tree: PredNode | None = None,
    *,
    index: IndexCacheStore = NULL_INDEX,
) -> list[str]:
    results = await walk(accessor,
                         path,
                         index,
                         include_root=True,
                         maxdepth=maxdepth,
                         strip_prefix=True)
    tree = tree if tree is not None else build_tree(name=name,
                                                    iname=iname,
                                                    path_pattern=path_pattern,
                                                    type=type,
                                                    name_exclude=name_exclude,
                                                    or_names=or_names,
                                                    empty=empty)
    needs_kind = (tree_has_type(tree) or min_size is not None
                  or max_size is not None or tree_has_empty(tree))
    start_name = start_basename(path)
    filtered: list[str] = []
    for item in results:
        if await _matches(accessor, item,
                          mount_prefix_of(path.virtual, path.resource_path),
                          index, path.mount_path, tree, needs_kind, min_size,
                          max_size, mtime_min, mtime_max, mindepth, start_name,
                          results):
            filtered.append(item)
    return sorted(filtered)


async def _matches(
    accessor: ChromaAccessor,
    item: str,
    prefix: str,
    index: IndexCacheStore,
    root: str,
    tree: PredNode,
    needs_kind: bool,
    min_size: int | None,
    max_size: int | None,
    mtime_min: float | None,
    mtime_max: float | None,
    mindepth: int | None,
    start_name: str,
    all_items: list[str],
) -> bool:
    root_norm = root.rstrip("/") or "/"
    item_norm = item.rstrip("/") or "/"
    item_name = (start_name if item_norm == root_norm else
                 item.rstrip("/").rsplit("/", 1)[-1])
    spec = PathSpec.from_str_path(item, mount_key(item, prefix))
    kind = "f"
    if needs_kind:
        resolved = await resolve_path(accessor, spec, index)
        kind = "d" if resolved.is_dir else "f"
    item_stat = None
    need_stat = ((min_size is not None or max_size is not None) and kind
                 != "d") or mtime_min is not None or mtime_max is not None
    if need_stat:
        item_stat = await stat(accessor, spec, index)
    is_empty = None
    if tree_has_empty(tree):
        if kind == "d":
            prefix = item.rstrip("/") + "/"
            is_empty = not any(other != item and other.startswith(prefix)
                               for other in all_items)
        else:
            if item_stat is None:
                item_stat = await stat(accessor, spec, index)
            is_empty = (item_stat.size or 0) == 0
    entry = FindEntry(key=item,
                      name=item_name,
                      kind=kind,
                      depth=_relative_depth(item, root),
                      is_empty=is_empty)
    if not keep(entry, tree, mindepth):
        return False
    # Directories count as size 0 for -size (deliberate GNU divergence).
    if min_size is not None or max_size is not None:
        if kind == "d":
            size = 0
        else:
            if item_stat is None:
                item_stat = await stat(accessor, spec, index)
            # Sizeless rendered files count as size 0, same as dirs and the
            # FUSE view (CLAUDE.md find -size rules); never drop them.
            size = item_stat.size if item_stat.size is not None else 0
        if min_size is not None and size < min_size:
            return False
        if max_size is not None and size > max_size:
            return False
    if not matches_mtime(item_stat.modified if item_stat is not None else None,
                         mtime_min, mtime_max):
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
