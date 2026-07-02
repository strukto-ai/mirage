from mirage.accessor.sharepoint import SharePointAccessor
from mirage.core.sharepoint._client import graph_get, item_url
from mirage.core.sharepoint._resolver import resolve
from mirage.types import PathSpec


def _current_version_id(versions: list[dict]) -> str | None:
    if not versions:
        return None
    current = max(versions, key=lambda v: v.get("lastModifiedDateTime") or "")
    return current.get("id")


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
