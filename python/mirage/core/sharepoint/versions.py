from urllib.parse import quote

from mirage.accessor.sharepoint import SharePointAccessor
from mirage.core.sharepoint._client import (graph_get, graph_list, graph_post,
                                            item_url)
from mirage.core.sharepoint._resolver import resolve
from mirage.types import PathSpec
from mirage.utils.errors import enoent


def _current_version_id(versions: list[dict]) -> str | None:
    if not versions:
        return None
    current = max(versions, key=lambda v: v.get("lastModifiedDateTime") or "")
    return current.get("id")


async def list_versions(accessor: SharePointAccessor,
                        path: PathSpec) -> list[dict]:
    resolved = await resolve(accessor, path)
    if resolved.drive_id is None or resolved.item_path is None:
        raise enoent(path.virtual if isinstance(path, PathSpec) else path)
    url = item_url(resolved.drive_id, resolved.item_path, action="/versions")
    return await graph_list(accessor.config, url)


async def current_version_id(accessor: SharePointAccessor,
                             path: PathSpec) -> str | None:
    versions = await list_versions(accessor, path)
    return _current_version_id(versions)


async def capture_metadata(
        accessor: SharePointAccessor,
        path: PathSpec) -> tuple[str | None, str | None, str | None]:
    resolved = await resolve(accessor, path)
    if resolved.drive_id is None or resolved.item_path is None:
        return None, None, None
    config = accessor.config
    item = await graph_get(config,
                           item_url(resolved.drive_id, resolved.item_path),
                           params={"$expand": "versions"})
    fingerprint = item.get("cTag")
    revision = _current_version_id(item.get("versions", []))
    download_url = item.get("@microsoft.graph.downloadUrl")
    return fingerprint, revision, download_url


async def restore_version(accessor: SharePointAccessor, path: PathSpec,
                          version_id: str) -> None:
    resolved = await resolve(accessor, path)
    if resolved.drive_id is None or resolved.item_path is None:
        raise enoent(path.virtual if isinstance(path, PathSpec) else path)
    action = f"/versions/{quote(version_id, safe='')}/restoreVersion"
    url = item_url(resolved.drive_id, resolved.item_path, action=action)
    await graph_post(accessor.config, url)
