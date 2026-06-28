from urllib.parse import quote

# yapf: disable
from mirage.core.msgraph._client import (GRAPH_API, MAX_BACKOFF,
                                         RETRY_STATUSES, GraphError,
                                         graph_delete, graph_get,
                                         graph_get_bytes, graph_list,
                                         graph_patch, graph_post,
                                         graph_post_monitor, graph_put_bytes,
                                         graph_stream, headers, new_session,
                                         poll_monitor, split_path,
                                         upload_chunk)

# yapf: enable

__all__ = [
    "GRAPH_API",
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
    "item_url",
    "new_session",
    "poll_monitor",
    "split_path",
    "upload_chunk",
]


def item_url(drive_id: str, path: str, action: str = "") -> str:
    base = f"{GRAPH_API}/drives/{drive_id}"
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
