# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

from dataclasses import dataclass
from functools import partial
from typing import Any, Literal
from urllib.parse import urlsplit

from mirage.accessor.sharepoint import SharePointAccessor
from mirage.core.msgraph.client import graph_list, id_segment
from mirage.core.msgraph.config import MsGraphConfig, graph_api
from mirage.core.msgraph.drive import DriveLoc
from mirage.core.sharepoint.client import drive_ref_path, item_url
from mirage.errors.fs import enoent
from mirage.types import PathSpec


@dataclass(frozen=True, slots=True)
class ResolvedPath:
    level: Literal["root", "site", "drive", "item"]
    site_id: str | None = None
    drive_id: str | None = None
    item_path: str | None = None


def _scoped_item_path(key_prefix: str | None, raw: str) -> str:
    prefix = (key_prefix or "").strip("/")
    if prefix and raw:
        return f"{prefix}/{raw}"
    return prefix or raw


def _text(value: Any) -> str:
    return value if isinstance(value, str) else ""


def _on_tenant(site: dict[str, Any], tenant_host: str) -> bool:
    """Whether a site lives on the configured tenant host.

    A site name is only unique within one tenant, so a site whose
    ``webUrl`` is on another host is another tenant's.

    Args:
        site (dict[str, Any]): a Graph site.
        tenant_host (str): the configured host, e.g.
            ``contoso.sharepoint.com``.
    """
    web_url = _text(site.get("webUrl"))
    return (
        bool(web_url)
        and urlsplit(web_url).netloc.lower() == tenant_host.lower()
    )


async def _site_items(accessor: SharePointAccessor) -> list[dict[str, Any]]:
    config = accessor.config
    params = {
        "search": config.site_filter or "*",
        "$select": "id,displayName,name,webUrl",
    }
    sites = await graph_list(
        config,
        f"{graph_api(config)}/sites",
        params=params,
        session=accessor.pool,
    )
    tenant_host = config.tenant_host
    if tenant_host is None:
        return sites
    return [s for s in sites if _on_tenant(s, tenant_host)]


async def _drive_items(
    accessor: SharePointAccessor, site_id: str
) -> list[dict[str, Any]]:
    url = f"{graph_api(accessor.config)}/sites/{id_segment(site_id)}/drives"
    return await graph_list(
        accessor.config,
        url,
        params={"$select": "id,name"},
        session=accessor.pool,
    )


async def site_entries(accessor: SharePointAccessor) -> list[tuple[str, str]]:
    """Every accessible site as (display name, id), sorted by name.

    A site with no id or no name is skipped: nothing could address it.
    Both the display name and the internal name are cached for
    resolution.

    Args:
        accessor (SharePointAccessor): the mount's accessor.
    """
    entries: list[tuple[str, str]] = []
    for s in await _site_items(accessor):
        site_id = _text(s.get("id"))
        name = _text(s.get("name"))
        display = _text(s.get("displayName")) or name
        if not site_id or not display:
            continue
        entries.append((display, site_id))
        accessor.site_cache[display] = site_id
        if name:
            accessor.site_cache[name] = site_id
    return sorted(entries, key=lambda entry: entry[0])


async def list_sites(accessor: SharePointAccessor) -> list[str]:
    return [name for name, _ in await site_entries(accessor)]


async def drive_entries(
    accessor: SharePointAccessor, site_id: str
) -> list[tuple[str, str]]:
    """A site's document libraries as (name, id), sorted by name.

    Args:
        accessor (SharePointAccessor): the mount's accessor.
        site_id (str): the site whose drives to list.
    """
    entries: list[tuple[str, str]] = []
    for d in await _drive_items(accessor, site_id):
        drive_id = _text(d.get("id"))
        name = _text(d.get("name"))
        if not drive_id or not name:
            continue
        entries.append((name, drive_id))
        accessor.drive_cache[(site_id, name)] = drive_id
    return sorted(entries, key=lambda entry: entry[0])


async def list_drives(accessor: SharePointAccessor, site_id: str) -> list[str]:
    return [name for name, _ in await drive_entries(accessor, site_id)]


async def _resolve_site_id(
    accessor: SharePointAccessor, name: str
) -> str | None:
    if name not in accessor.site_cache:
        await site_entries(accessor)
    return accessor.site_cache.get(name)


async def _resolve_drive_id(
    accessor: SharePointAccessor, site_id: str, name: str
) -> str | None:
    key = (site_id, name)
    if key not in accessor.drive_cache:
        await drive_entries(accessor, site_id)
    return accessor.drive_cache.get(key)


async def resolve(
    accessor: SharePointAccessor, path: PathSpec
) -> ResolvedPath:
    """Resolve a mount path to its site, drive and drive-relative item.

    A mount scoped to one site and drive (both configured) lives inside
    that drive, so its paths are drive-relative and the namespace levels
    vanish. An unscoped mount exposes ``/<site>/<library>/...``.

    Args:
        accessor (SharePointAccessor): the mount's accessor.
        path (PathSpec): the path to resolve.
    """
    raw = path.vfs_path.strip("/")
    config = accessor.config
    if config.site is not None and config.drive is not None:
        site_id = await _resolve_site_id(accessor, config.site)
        if site_id is None:
            return ResolvedPath(level="site")
        drive_id = await _resolve_drive_id(accessor, site_id, config.drive)
        if drive_id is None:
            return ResolvedPath(level="drive", site_id=site_id)
        item_path = _scoped_item_path(config.key_prefix, raw)
        if not item_path:
            return ResolvedPath(
                level="drive", site_id=site_id, drive_id=drive_id
            )
        return ResolvedPath(
            level="item",
            site_id=site_id,
            drive_id=drive_id,
            item_path=item_path,
        )
    if not raw:
        return ResolvedPath(level="root")
    parts = raw.split("/", 2)
    site_id = await _resolve_site_id(accessor, parts[0])
    if site_id is None:
        return ResolvedPath(level="site")
    if len(parts) == 1:
        return ResolvedPath(level="site", site_id=site_id)
    drive_id = await _resolve_drive_id(accessor, site_id, parts[1])
    if drive_id is None:
        return ResolvedPath(level="drive", site_id=site_id)
    if len(parts) == 2:
        return ResolvedPath(level="drive", site_id=site_id, drive_id=drive_id)
    return ResolvedPath(
        level="item", site_id=site_id, drive_id=drive_id, item_path=parts[2]
    )


def require_item(path: PathSpec, resolved: ResolvedPath) -> None:
    """Raise ENOENT unless ``resolved`` names a drive item.

    Args:
        path (PathSpec): the path ``resolved`` came from, named by the
            error.
        resolved (ResolvedPath): its resolution.
    """
    if resolved.drive_id is None or resolved.item_path is None:
        raise enoent(path)


async def resolve_item(
    accessor: SharePointAccessor, path: PathSpec
) -> ResolvedPath:
    resolved = await resolve(accessor, path)
    require_item(path, resolved)
    return resolved


def drive_loc(
    config: MsGraphConfig, resolved: ResolvedPath, virt: str
) -> DriveLoc:
    drive_id = resolved.drive_id
    if drive_id is None:
        raise ValueError("SharePoint path has no drive")
    return DriveLoc(
        drive=drive_id,
        path=resolved.item_path or "",
        virt=virt.strip("/"),
        url=partial(item_url, config, drive_id),
        ref=partial(drive_ref_path, drive_id),
    )
