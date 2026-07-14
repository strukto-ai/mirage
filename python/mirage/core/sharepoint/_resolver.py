from dataclasses import dataclass
from typing import Literal

from mirage.accessor.sharepoint import SharePointAccessor
from mirage.core.sharepoint._client import GRAPH_API, graph_list
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of


@dataclass(frozen=True, slots=True)
class ResolvedPath:
    level: Literal["root", "site", "drive", "item"]
    site_id: str | None = None
    drive_id: str | None = None
    item_path: str | None = None


_site_cache: dict[str, str] = {}
_drive_cache: dict[tuple[str, str], str] = {}


async def _list_sites(accessor: SharePointAccessor) -> list[dict]:
    config = accessor.config
    search = config.site_filter or "*"
    url = f"{GRAPH_API}/sites"
    params = {"search": search, "$select": "id,displayName,name"}
    return await graph_list(config, url, params=params)


async def _list_drives(accessor: SharePointAccessor,
                       site_id: str) -> list[dict]:
    url = f"{GRAPH_API}/sites/{site_id}/drives"
    params = {"$select": "id,name"}
    return await graph_list(accessor.config, url, params=params)


async def _resolve_site_id(accessor: SharePointAccessor,
                           site_name: str) -> str | None:
    if site_name in _site_cache:
        return _site_cache[site_name]
    sites = await _list_sites(accessor)
    for s in sites:
        display = s.get("displayName", "")
        name = s.get("name", "")
        _site_cache[display] = s["id"]
        _site_cache[name] = s["id"]
    return _site_cache.get(site_name)


async def _resolve_drive_id(accessor: SharePointAccessor, site_id: str,
                            drive_name: str) -> str | None:
    key = (site_id, drive_name)
    if key in _drive_cache:
        return _drive_cache[key]
    drives = await _list_drives(accessor, site_id)
    for d in drives:
        _drive_cache[(site_id, d.get("name", ""))] = d["id"]
    return _drive_cache.get(key)


async def resolve(accessor: SharePointAccessor,
                  path: PathSpec | str) -> ResolvedPath:
    """Resolve a virtual path to (site_id, drive_id, item_path).

    Args:
        accessor (SharePointAccessor): The accessor with config.
        path (PathSpec | str): Virtual path to resolve.

    Returns:
        ResolvedPath: Resolved components.
    """
    prefix = mount_prefix_of(path.virtual, path.resource_path) or ""
    raw = path.virtual
    if prefix and raw.startswith(prefix):
        rest = raw[len(prefix):]
        if prefix.endswith("/") or rest == "" or rest.startswith("/"):
            raw = rest or "/"
    raw = raw.strip("/")

    if not raw:
        return ResolvedPath(level="root")

    parts = raw.split("/", 2)

    site_name = parts[0]
    site_id = await _resolve_site_id(accessor, site_name)
    if site_id is None:
        return ResolvedPath(level="site", site_id=None)

    if len(parts) == 1:
        return ResolvedPath(level="site", site_id=site_id)

    drive_name = parts[1]
    drive_id = await _resolve_drive_id(accessor, site_id, drive_name)
    if drive_id is None:
        return ResolvedPath(level="drive", site_id=site_id, drive_id=None)

    if len(parts) == 2:
        return ResolvedPath(level="drive", site_id=site_id, drive_id=drive_id)

    item_path = parts[2]
    return ResolvedPath(level="item",
                        site_id=site_id,
                        drive_id=drive_id,
                        item_path=item_path)


async def list_sites(accessor: SharePointAccessor) -> list[str]:
    """Return display names of all accessible sites.

    Args:
        accessor (SharePointAccessor): The accessor.

    Returns:
        list[str]: Site display names.
    """
    sites = await _list_sites(accessor)
    names: list[str] = []
    for s in sites:
        display = s.get("displayName", s.get("name", ""))
        names.append(display)
        _site_cache[display] = s["id"]
    return sorted(names)


async def list_drives(accessor: SharePointAccessor, site_id: str) -> list[str]:
    """Return drive names for a site.

    Args:
        accessor (SharePointAccessor): The accessor.
        site_id (str): Site ID.

    Returns:
        list[str]: Drive names.
    """
    drives = await _list_drives(accessor, site_id)
    names: list[str] = []
    for d in drives:
        name = d.get("name", "")
        names.append(name)
        _drive_cache[(site_id, name)] = d["id"]
    return sorted(names)
