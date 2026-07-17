from functools import partial

from mirage.accessor.sharepoint import SharePointAccessor
from mirage.cache.index import NULL_INDEX
from mirage.commands.builtin.find_eval import PredNode, start_basename
from mirage.core.msgraph.drive_ops import find_items
from mirage.core.sharepoint._resolver import drive_loc, resolve
from mirage.core.sharepoint.stat import stat
from mirage.types import FileType, PathSpec


async def _dir_exists(accessor: SharePointAccessor, path: PathSpec) -> bool:
    try:
        info = await stat(accessor, path, index=NULL_INDEX)
    except FileNotFoundError:
        return False
    return info.type == FileType.DIRECTORY


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
