from urllib.parse import quote

# yapf: disable
from mirage.core.msgraph._client import (MAX_BACKOFF, RETRY_STATUSES,
                                         GraphError, graph_delete, graph_get,
                                         graph_get_bytes, graph_list,
                                         graph_patch, graph_post,
                                         graph_post_monitor, graph_put_bytes,
                                         graph_stream, headers, id_segment,
                                         new_session, poll_monitor, split_path,
                                         upload_chunk)
# yapf: enable
from mirage.core.msgraph.config import MsGraphConfig, graph_api

__all__ = [
    "graph_api",
    "MAX_BACKOFF",
    "RETRY_STATUSES",
    "GraphError",
    "drive_ref_path",
    "graph_delete",
    "graph_get",
    "graph_get_bytes",
    "graph_list",
    "graph_patch",
    "graph_post",
    "graph_post_monitor",
    "graph_put_bytes",
    "graph_stream",
    "headers",
    "id_segment",
    "item_url",
    "new_session",
    "poll_monitor",
    "split_path",
    "upload_chunk",
]


def item_url(config: MsGraphConfig,
             drive_id: str,
             path: str,
             action: str = "") -> str:
    """A drive item's Graph URL.

    Takes the config, not just the drive id, because the service root is
    a per-mount setting (national cloud, private endpoint, test server)
    rather than a constant.

    Args:
        config (MsGraphConfig): mount config carrying the service root.
        drive_id (str): drive holding the item.
        path (str): drive-relative item path.
        action (str): optional trailing Graph action, e.g. ``/content``.
    """
    base = f"{graph_api(config)}/drives/{id_segment(drive_id)}"
    p = path.strip("/")
    if not p:
        return f"{base}/root{action}"
    stem = f"{base}/root:/{quote(p, safe='/')}"
    if action:
        return f"{stem}:{action}"
    return stem


def drive_ref_path(drive_id: str, folder: str = "") -> str:
    base = f"/drives/{drive_id}"
    if folder:
        return f"{base}/root:/{quote(folder, safe='/')}"
    return f"{base}/root:"
