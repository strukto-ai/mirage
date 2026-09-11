from collections.abc import Awaitable, Callable
from typing import Protocol, TypeVar

from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.find_eval import (FindEntry, PredNode, build_tree,
                                               keep, start_basename,
                                               tree_has_empty, tree_has_type)
from mirage.types import FileStat, PathSpec
from mirage.utils.dates import matches_mtime
from mirage.utils.key_prefix import mount_prefix_of


class ResolvedPath(Protocol):

    @property
    def is_dir(self) -> bool:
        ...


# The accessor stays a type variable rather than the `Accessor` base:
# callable parameters are contravariant, so a `ChromaAccessor` op does
# not fit an `Accessor` slot. Mirrors the TS factory's `<A>`.
A = TypeVar("A")

ResolvePathFn = Callable[[A, PathSpec, IndexCacheStore],
                         Awaitable[ResolvedPath]]

StatFn = Callable[[A, PathSpec, IndexCacheStore], Awaitable[FileStat]]

WalkFn = Callable[..., Awaitable[list[str]]]

FindFn = Callable[..., Awaitable[list[str]]]


def relative_depth(item: str, root: str) -> int:
    """Depth of ``item`` below ``root``, counting the root itself as 0.

    Args:
        item (str): the walked key.
        root (str): the search root's mount path.
    """
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


async def _matches(
    resolve_path: ResolvePathFn[A],
    stat: StatFn[A],
    accessor: A,
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
    """Whether one walked key survives the predicate tree and filters.

    Args:
        resolve_path (ResolvePathFn[A]): the backend's directory test.
        stat (StatFn[A]): the backend's stat.
        accessor (A): the backend handle.
        item (str): the walked key.
        prefix (str): the mount prefix the key belongs to.
        index (IndexCacheStore): the index the walk ran against.
        root (str): the search root's mount path.
        tree (PredNode): the parsed predicate tree.
        needs_kind (bool): whether any predicate needs the entry kind.
        min_size (int | None): inclusive lower size bound.
        max_size (int | None): inclusive upper size bound.
        mtime_min (float | None): inclusive lower mtime bound.
        mtime_max (float | None): inclusive upper mtime bound.
        mindepth (int | None): least depth to report.
        start_name (str): the name the root reports as.
        all_items (list[str]): every walked key, for the ``-empty`` test.
    """
    root_norm = root.rstrip("/") or "/"
    item_norm = item.rstrip("/") or "/"
    item_name = (start_name if item_norm == root_norm else
                 item.rstrip("/").rsplit("/", 1)[-1])
    # The walk strips its mount prefix; backend probes still need both paths.
    virtual = (prefix.rstrip("/") + "/" + item.lstrip("/")).rstrip("/") or "/"
    spec = PathSpec.from_str_path(virtual, item.lstrip("/"))
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
            child_prefix = item.rstrip("/") + "/"
            is_empty = not any(other != item and other.startswith(child_prefix)
                               for other in all_items)
        else:
            if item_stat is None:
                item_stat = await stat(accessor, spec, index)
            is_empty = (item_stat.size or 0) == 0
    entry = FindEntry(key=item,
                      name=item_name,
                      kind=kind,
                      depth=relative_depth(item, root),
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


def make_search_backed_find(resolve_path: ResolvePathFn[A], stat: StatFn[A],
                            walk: WalkFn) -> FindFn:
    """Build ``find`` for a backend whose walk comes from a search index.

    The search-backed backends (chroma, dify) get the whole subtree from
    one ``walk`` call and then filter it, where the API backends drive
    the traversal themselves through ``walk_find``'s ``readdir``. That is
    the only difference between them, so everything after the walk lives
    here once rather than once per backend.

    Args:
        resolve_path (ResolvePathFn[A]): the backend's directory test.
        stat (StatFn[A]): the backend's stat.
        walk (WalkFn): the backend's subtree walk.
    """

    async def find(
        accessor: A,
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
        node = tree if tree is not None else build_tree(
            name=name,
            iname=iname,
            path_pattern=path_pattern,
            type=type,
            name_exclude=name_exclude,
            or_names=or_names,
            empty=empty)
        needs_kind = (tree_has_type(node) or min_size is not None
                      or max_size is not None or tree_has_empty(node))
        start_name = start_basename(path)
        prefix = mount_prefix_of(path.virtual, path.resource_path)
        filtered: list[str] = []
        for item in results:
            if await _matches(resolve_path, stat, accessor, item, prefix,
                              index, path.mount_path, node, needs_kind,
                              min_size, max_size, mtime_min, mtime_max,
                              mindepth, start_name, results):
                filtered.append(item)
        return sorted(filtered)

    return find
