from mirage.accessor.sharepoint import SharePointAccessor
from mirage.cache.index import NULL_INDEX
from mirage.core.sharepoint._client import new_session
from mirage.core.sharepoint._resolver import resolve
from mirage.core.sharepoint.find import iter_tree
from mirage.core.sharepoint.stat import stat
from mirage.types import FileType, PathSpec


async def du(accessor: SharePointAccessor, path: PathSpec) -> int:
    try:
        info = await stat(accessor, path, index=NULL_INDEX)
    except FileNotFoundError:
        info = None
    if info is not None and info.type != FileType.DIRECTORY:
        return info.size or 0
    resolved = await resolve(accessor, path)
    if resolved.drive_id is None:
        return 0
    item_base = resolved.item_path or ""
    total = 0
    async with new_session(accessor.config) as session:
        async for _rel, item, is_dir in iter_tree(accessor.config,
                                                  resolved.drive_id,
                                                  item_base,
                                                  session=session):
            if not is_dir:
                total += item.get("size", 0)
    return total


async def du_all(accessor: SharePointAccessor,
                 path: PathSpec) -> list[tuple[str, int]]:
    try:
        info = await stat(accessor, path, index=NULL_INDEX)
    except FileNotFoundError:
        info = None
    if info is not None and info.type != FileType.DIRECTORY:
        return []
    resolved = await resolve(accessor, path)
    if resolved.drive_id is None:
        return []
    item_base = resolved.item_path or ""
    results: list[tuple[str, int]] = []
    total = 0
    async with new_session(accessor.config) as session:
        async for rel, item, is_dir in iter_tree(accessor.config,
                                                 resolved.drive_id,
                                                 item_base,
                                                 session=session):
            if is_dir:
                continue
            size = item.get("size", 0)
            results.append(("/" + rel, size))
            total += size
    results.append(("/" + item_base if item_base else "/", total))
    return results
