from opendal.exceptions import NotFound
from opendal.types import EntryMode

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.commands.builtin.find_eval import (FindEntry, PredNode, build_tree,
                                               emit_start_path, keep,
                                               start_basename)
from mirage.types import PathSpec


async def find(
    accessor: NextcloudAccessor,
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
) -> list[str]:
    start_name = start_basename(path)
    target = path.mount_path
    pfx = target.strip("/")
    scan_path = pfx + "/" if pfx else "/"
    base = "/" + pfx if pfx else "/"
    base_depth = 0 if base == "/" else base.count("/")

    op = accessor.operator()
    results: list[str] = []
    seen_dirs: set[str] = set()
    saw_descendant = False
    dir_exists = False
    tree = tree if tree is not None else build_tree(name=name,
                                                    iname=iname,
                                                    path_pattern=path_pattern,
                                                    type=type,
                                                    name_exclude=name_exclude,
                                                    or_names=or_names)
    try:
        async for entry in await op.scan(scan_path):
            rel = entry.path
            if not rel:
                continue
            meta = entry.metadata
            is_dir = (rel.endswith("/")
                      or getattr(meta, "mode", None) == EntryMode.Dir)
            entry_path = "/" + rel.rstrip("/").lstrip("/")
            if entry_path == base:
                dir_exists = True
                continue
            saw_descendant = True
            kind = "d" if is_dir else "f"
            content_length = getattr(meta, "content_length", 0) or 0
            last_modified = getattr(meta, "last_modified", None)

            file_entries: list[tuple[str, str]] = [(entry_path, kind)]
            if not is_dir:
                parent = entry_path.rsplit("/", 1)[0] or "/"
                while parent and parent != base and parent != "/":
                    if parent not in seen_dirs:
                        seen_dirs.add(parent)
                        file_entries.append((parent, "d"))
                    parent = parent.rsplit("/", 1)[0] or "/"

            for ep, k in file_entries:
                en = ep.rsplit("/", 1)[-1]
                depth = ep.count("/") - base_depth
                if maxdepth is not None and depth > maxdepth:
                    continue
                fe = FindEntry(
                    key=ep,
                    name=en,
                    kind=k,
                    depth=depth,
                    is_empty=False if k == "d" else content_length == 0)
                if not keep(fe, tree, mindepth):
                    continue

                if min_size is not None or max_size is not None:
                    # Directories count as size 0 for -size (deliberate GNU
                    # divergence).
                    size = content_length if k == "f" else 0
                    if min_size is not None and size < min_size:
                        continue
                    if max_size is not None and size > max_size:
                        continue

                if mtime_min is not None or mtime_max is not None:
                    if last_modified is None:
                        continue
                    mt = last_modified.timestamp()
                    if mtime_min is not None and mt < mtime_min:
                        continue
                    if mtime_max is not None and mt > mtime_max:
                        continue

                results.append(ep)
    except NotFound:
        return []
    if saw_descendant or dir_exists:
        emit_start_path(results,
                        base,
                        start_name,
                        kind="d",
                        is_empty=False,
                        exists=True,
                        tree=tree,
                        maxdepth=maxdepth,
                        mindepth=mindepth,
                        min_size=min_size,
                        max_size=max_size)
    return sorted(set(results))
