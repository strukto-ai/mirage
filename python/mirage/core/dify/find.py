from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.find_eval import (FindEntry, PredNode, build_tree,
                                               keep, start_basename,
                                               tree_has_type)
from mirage.core.dify.path import resolve_path
from mirage.core.dify.stat import stat
from mirage.core.dify.walk import walk
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key, mount_prefix_of


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
    empty: bool = False,
    tree: PredNode | None = None,
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
    tree = tree if tree is not None else build_tree(name=name,
                                                    iname=iname,
                                                    path_pattern=path_pattern,
                                                    type=type,
                                                    name_exclude=name_exclude,
                                                    or_names=or_names)
    needs_kind = (tree_has_type(tree) or min_size is not None
                  or max_size is not None)
    start_name = start_basename(path)
    filtered: list[str] = []
    for item in results:
        if await _matches(accessor, item,
                          mount_prefix_of(path.virtual, path.resource_path),
                          index, path.mount_path, tree, needs_kind, min_size,
                          max_size, mindepth, start_name):
            filtered.append(item)
    return sorted(filtered)


async def _matches(
    accessor,
    item: str,
    prefix: str,
    index: IndexCacheStore,
    root: str,
    tree: PredNode,
    needs_kind: bool,
    min_size: int | None,
    max_size: int | None,
    mindepth: int | None,
    start_name: str,
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
    entry = FindEntry(key=item,
                      name=item_name,
                      kind=kind,
                      depth=_relative_depth(item, root))
    if not keep(entry, tree, mindepth):
        return False
    # Directories count as size 0 for -size (deliberate GNU divergence).
    if min_size is not None or max_size is not None:
        if kind == "d":
            size = 0
        else:
            item_stat = await stat(accessor, spec, index)
            # Sizeless rendered files count as size 0, same as dirs and the
            # FUSE view (CLAUDE.md find -size rules); never drop them.
            size = item_stat.size if item_stat.size is not None else 0
        if min_size is not None and size < min_size:
            return False
        if max_size is not None and size > max_size:
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
