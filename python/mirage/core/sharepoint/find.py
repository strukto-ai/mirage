from functools import partial

from mirage.accessor.sharepoint import SharePointAccessor
from mirage.cache.index import NULL_INDEX
from mirage.commands.builtin.find_eval import (FindEntry, PredNode, build_tree,
                                               emit_start_path, keep,
                                               start_basename)
from mirage.core.msgraph.drive_ops import drive_root_empty, find_items
from mirage.core.sharepoint._resolver import (ResolvedPath, drive_entries,
                                              drive_loc, resolve, site_entries)
from mirage.core.sharepoint.stat import stat
from mirage.types import FileType, PathSpec


async def _dir_exists(accessor: SharePointAccessor, path: PathSpec) -> bool:
    try:
        info = await stat(accessor, path, index=NULL_INDEX)
    except FileNotFoundError:
        return False
    return info.type == FileType.DIRECTORY


def _push_namespace_dir(
    results: list[str],
    key: str,
    name: str,
    depth: int,
    is_empty: bool | None,
    tree: PredNode,
    maxdepth: int | None,
    mindepth: int | None,
    min_size: int | None,
) -> None:
    if maxdepth is not None and depth > maxdepth:
        return
    entry = FindEntry(key=key,
                      name=name,
                      kind="d",
                      depth=depth,
                      is_empty=is_empty)
    if not keep(entry, tree, mindepth):
        return
    # Directories count as size 0 for -size (deliberate GNU divergence).
    if min_size is not None and min_size > 0:
        return
    results.append(key)


async def _find_namespace(
    accessor: SharePointAccessor,
    path: PathSpec,
    resolved: ResolvedPath,
    tree: PredNode,
    *,
    name: str | None,
    type: str | None,
    min_size: int | None,
    max_size: int | None,
    maxdepth: int | None,
    name_exclude: str | None,
    or_names: list[str] | None,
    iname: str | None,
    path_pattern: str | None,
    mindepth: int | None,
    empty: bool,
) -> list[str]:
    base = path.resource_path.strip("/")
    at_root = resolved.level == "root"
    offset = 1 if at_root else 0
    sites = (await site_entries(accessor)
             if at_root else [(base, resolved.site_id or "")])
    results: list[str] = []
    start_empty = not sites
    for site_name, site_id in sites:
        site_key = site_name if at_root else base
        want_drives = empty or maxdepth is None or maxdepth >= offset + 1
        drives = await drive_entries(accessor, site_id) if want_drives else []
        if at_root:
            _push_namespace_dir(results, "/" + site_key, site_name, 1,
                                not drives, tree, maxdepth, mindepth, min_size)
        else:
            start_empty = not drives
        for drive_name, drive_id in drives:
            drive_key = f"{site_key}/{drive_name}"
            loc = drive_loc(
                ResolvedPath(level="drive", site_id=site_id,
                             drive_id=drive_id), drive_key)
            is_empty = (await drive_root_empty(accessor.config, loc)
                        if empty else None)
            _push_namespace_dir(results, "/" + drive_key, drive_name,
                                offset + 1, is_empty, tree, maxdepth, mindepth,
                                min_size)
            if maxdepth is not None and maxdepth <= offset + 1:
                continue
            results.extend(await find_items(accessor.config,
                                            loc,
                                            drive_name,
                                            _never,
                                            name=name,
                                            type=type,
                                            min_size=min_size,
                                            max_size=max_size,
                                            maxdepth=maxdepth,
                                            name_exclude=name_exclude,
                                            or_names=or_names,
                                            iname=iname,
                                            path_pattern=path_pattern,
                                            mindepth=mindepth,
                                            empty=empty,
                                            tree=tree,
                                            depth_offset=offset + 1,
                                            emit_start=False))
    emit_start_path(results,
                    "/" + base if base else "/",
                    start_basename(path),
                    kind="d",
                    is_empty=start_empty if empty else None,
                    exists=True,
                    tree=tree,
                    maxdepth=maxdepth,
                    mindepth=mindepth,
                    min_size=min_size,
                    max_size=max_size)
    return sorted(results)


async def _never() -> bool:
    return False


async def find(
    accessor: SharePointAccessor,
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
    resolved = await resolve(accessor, path)
    if resolved.drive_id is None:
        # An unscoped mount exposes two synthetic directory levels above
        # the document libraries (/<Site>/<Library>/...). readdir walks
        # them, so find has to as well: those levels carry no drive id,
        # and delegating straight to find_items would report the whole
        # tree as empty.
        if resolved.level == "root" or (resolved.level == "site"
                                        and resolved.site_id is not None):
            walk_tree = tree if tree is not None else build_tree(
                name=name,
                iname=iname,
                path_pattern=path_pattern,
                type=type,
                name_exclude=name_exclude,
                or_names=or_names,
                empty=empty)
            return await _find_namespace(accessor,
                                         path,
                                         resolved,
                                         walk_tree,
                                         name=name,
                                         type=type,
                                         min_size=min_size,
                                         max_size=max_size,
                                         maxdepth=maxdepth,
                                         name_exclude=name_exclude,
                                         or_names=or_names,
                                         iname=iname,
                                         path_pattern=path_pattern,
                                         mindepth=mindepth,
                                         empty=empty)
        return []
    virt = path.mount_path if isinstance(path, PathSpec) else path
    return await find_items(accessor.config,
                            drive_loc(resolved, virt),
                            start_basename(path),
                            partial(_dir_exists, accessor, path),
                            name=name,
                            type=type,
                            min_size=min_size,
                            max_size=max_size,
                            maxdepth=maxdepth,
                            name_exclude=name_exclude,
                            or_names=or_names,
                            iname=iname,
                            path_pattern=path_pattern,
                            mindepth=mindepth,
                            empty=empty,
                            tree=tree)
