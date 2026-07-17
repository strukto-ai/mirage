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

import posixpath

from mirage.accessor.onedrive import OneDriveAccessor, OneDriveConfig
from mirage.cache.context import invalidate_after_write
from mirage.core.onedrive._client import (GraphError, drive_ref_path,
                                          graph_delete, graph_get, graph_list,
                                          graph_post_monitor, item_url,
                                          poll_monitor, split_path)
from mirage.types import PathSpec


async def _copy_once(config: OneDriveConfig, src_s: str,
                     dst_s: str) -> tuple[str, str] | None:
    """One Graph copy attempt, surfacing a conflict instead of raising.

    Graph copies default to ``fail`` on a name conflict and the
    ``@microsoft.graph.conflictBehavior=replace`` query parameter is not
    supported on OneDrive Consumer, so the caller resolves conflicts
    itself (delete-and-retry for files, per-child merge for folders).

    Args:
        config (OneDriveConfig): OneDrive config.
        src_s (str): resource-relative source path.
        dst_s (str): resource-relative destination path.

    Returns:
        tuple[str, str] | None: ``(code, message)`` of a failed copy, or
        None when the copy completed.
    """
    dst_parent = posixpath.dirname("/" + dst_s).strip("/")
    body = {
        "name": posixpath.basename(dst_s),
        "parentReference": {
            "path": drive_ref_path(config, dst_parent)
        },
    }
    url = item_url(config, "/" + src_s, action="/copy")
    try:
        monitor = await graph_post_monitor(config, url, body)
    except GraphError as exc:
        if exc.status == 409 or exc.code == "nameAlreadyExists":
            return exc.code, str(exc)
        raise
    if not monitor:
        return None
    result = await poll_monitor(monitor, timeout=config.timeout)
    status = result.get("status")
    if status == "failed":
        err = result.get("error", {}) if isinstance(result, dict) else {}
        return (err.get("code", "copyFailed"),
                err.get("message", f"copy {src_s} -> {dst_s} failed"))
    if status not in ("completed", None):
        raise GraphError(504, "copyTimeout",
                         f"copy {src_s} -> {dst_s} not confirmed complete")
    return None


async def _copy_tree(config: OneDriveConfig, src_s: str, dst_s: str) -> None:
    err = await _copy_once(config, src_s, dst_s)
    if err is None:
        await invalidate_after_write(dst_s)
        return
    code, message = err
    if code != "nameAlreadyExists":
        raise GraphError(500, code, message)
    src_item = await graph_get(config, item_url(config, "/" + src_s))
    dst_item = await graph_get(config, item_url(config, "/" + dst_s))
    if "folder" in src_item and "folder" in dst_item:
        # GNU cp -r merges into an existing directory; Graph never merges
        # folders, so recurse per child instead.
        children = await graph_list(
            config, item_url(config, "/" + src_s, action="/children"))
        for child in children:
            name = child.get("name", "")
            await _copy_tree(config, f"{src_s}/{name}", f"{dst_s}/{name}")
        return
    if "folder" in src_item or "folder" in dst_item:
        raise GraphError(409, code, message)
    await graph_delete(config, item_url(config, "/" + dst_s))
    err = await _copy_once(config, src_s, dst_s)
    if err is not None:
        raise GraphError(500, err[0], err[1])
    await invalidate_after_write(dst_s)


async def copy(accessor: OneDriveAccessor, src: PathSpec,
               dst: PathSpec) -> None:
    _, src_s = split_path(src)
    _, dst_s = split_path(dst)
    await _copy_tree(accessor.config, src_s, dst_s)
    await invalidate_after_write(dst)
