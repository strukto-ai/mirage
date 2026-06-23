from collections.abc import AsyncIterator

import aiohttp

from mirage.accessor.sharepoint import SharePointAccessor
from mirage.commands.builtin.find_eval import (FindEntry, PredNode, build_tree,
                                               keep)
from mirage.core.sharepoint._client import (graph_list, item_url, new_session,
                                            split_path)
from mirage.core.sharepoint._resolver import resolve
from mirage.core.sharepoint.stat import stat
from mirage.types import FileType, PathSpec


async def iter_tree(
    config,
    drive_id: str,
    base: str,
    session: aiohttp.ClientSession | None = None,
) -> AsyncIterator[tuple[str, dict, bool]]:
    url = item_url(drive_id, "/" + base if base else "/", action="/children")
    children = await graph_list(config, url, session=session)
    for child in children:
        cname = child.get("name", "")
        rel = f"{base}/{cname}" if base else cname
        is_dir = "folder" in child
        yield rel, child, is_dir
        if is_dir:
            async for entry in iter_tree(config,
                                         drive_id,
                                         rel,
                                         session=session):
                yield entry


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
    _, base_stripped = split_path(path)
    resolved = await resolve(accessor, path)
    if resolved.drive_id is None:
        return []
    drive_id = resolved.drive_id
    item_base = resolved.item_path or ""
    results: list[str] = []
    saw_descendant = False
    tree = tree if tree is not None else build_tree(name=name,
                                                    iname=iname,
                                                    path_pattern=path_pattern,
                                                    type=type,
                                                    name_exclude=name_exclude,
                                                    or_names=or_names,
                                                    empty=empty)
    async with new_session(accessor.config) as session:
        async for rel, item, is_dir in iter_tree(accessor.config,
                                                 drive_id,
                                                 item_base,
                                                 session=session):
            relative = rel[len(item_base):].lstrip("/") if item_base else rel
            depth = relative.count("/") + 1
            if maxdepth is not None and depth > maxdepth:
                continue
            saw_descendant = True
            entry_name = rel.rsplit("/", 1)[-1]
            full_path = "/" + rel
            size = item.get("size", 0)
            is_empty = (None if not empty else
                        (size == 0 if not is_dir else False))
            entry = FindEntry(key=full_path,
                              name=entry_name,
                              kind="d" if is_dir else "f",
                              depth=depth,
                              is_empty=is_empty)
            if not keep(entry, tree, mindepth):
                continue
            if not is_dir:
                if min_size is not None and size < min_size:
                    continue
                if max_size is not None and size > max_size:
                    continue
            results.append(full_path)
    dir_exists = saw_descendant
    if item_base and not dir_exists:
        try:
            dir_exists = (await stat(accessor,
                                     path)).type == FileType.DIRECTORY
        except FileNotFoundError:
            dir_exists = False
    if item_base and dir_exists and (maxdepth is None or maxdepth >= 0):
        root_entry = FindEntry(key="/" + item_base,
                               name=item_base.rsplit("/", 1)[-1],
                               kind="d",
                               depth=0,
                               is_empty=False if empty else None)
        if keep(root_entry, tree, mindepth):
            results.append("/" + item_base)
    return sorted(results)
