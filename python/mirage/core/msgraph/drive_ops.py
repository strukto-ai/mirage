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
from collections.abc import Callable
from dataclasses import dataclass, replace

from mirage.cache.context import invalidate_after_write
from mirage.core.msgraph._client import (GraphError, graph_delete, graph_get,
                                         graph_list, graph_patch, graph_post,
                                         graph_post_monitor, poll_monitor,
                                         upload_chunk)
from mirage.core.msgraph.config import MsGraphConfig

SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024
UPLOAD_CHUNK = 10 * 327680


@dataclass(frozen=True, slots=True)
class DriveLoc:
    """One drive item address, independent of how the backend spells URLs.

    OneDrive builds URLs from its config (one implicit drive plus
    ``key_prefix``); SharePoint resolves site and drive segments first.
    Both hand the shared drive operations a ``DriveLoc`` so the conflict
    machinery is written once.

    Args:
        drive (str): Opaque drive identity for cross-drive comparison
            (empty for single-drive backends).
        path (str): Backend-addressing item path.
        virt (str): Mount-relative path for cache invalidation.
        url (Callable[[str, str], str]): Maps ``(path, action)`` to a
            full Graph URL.
        ref (Callable[[str], str]): Maps a folder path to a
            ``parentReference`` drive ref path.
    """

    drive: str
    path: str
    virt: str
    url: Callable[[str, str], str]
    ref: Callable[[str], str]

    def item(self, action: str = "") -> str:
        return self.url(self.path, action)

    def child(self, name: str) -> "DriveLoc":
        return replace(self,
                       path=f"{self.path}/{name}",
                       virt=f"{self.virt}/{name}")

    def parent(self) -> str:
        return posixpath.dirname("/" + self.path).strip("/")


def _parent_reference(src: DriveLoc, dst: DriveLoc) -> dict:
    ref: dict = {"path": dst.ref(dst.parent())}
    if src.drive != dst.drive and dst.drive:
        ref["driveId"] = dst.drive
    return ref


async def copy_once(config: MsGraphConfig, src: DriveLoc,
                    dst: DriveLoc) -> tuple[str, str] | None:
    """One Graph copy attempt, surfacing a conflict instead of raising.

    Graph copies default to ``fail`` on a name conflict and the
    ``@microsoft.graph.conflictBehavior=replace`` query parameter is
    files-only (and unsupported on OneDrive Consumer), so the caller
    resolves conflicts itself (delete-and-retry for files, per-child
    merge for folders).

    Args:
        config (MsGraphConfig): Graph config.
        src (DriveLoc): source item.
        dst (DriveLoc): destination item.

    Returns:
        tuple[str, str] | None: ``(code, message)`` of a failed copy, or
        None when the copy completed.
    """
    body = {
        "name": posixpath.basename(dst.path),
        "parentReference": _parent_reference(src, dst),
    }
    try:
        monitor = await graph_post_monitor(config, src.item("/copy"), body)
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
                err.get("message", f"copy {src.path} -> {dst.path} failed"))
    if status not in ("completed", None):
        raise GraphError(504, "copyTimeout",
                         f"copy {src.path} -> {dst.path} not confirmed")
    return None


async def copy_tree(config: MsGraphConfig, src: DriveLoc,
                    dst: DriveLoc) -> None:
    err = await copy_once(config, src, dst)
    if err is None:
        await invalidate_after_write(dst.virt)
        return
    code, message = err
    if code != "nameAlreadyExists":
        raise GraphError(500, code, message)
    src_item = await graph_get(config, src.item())
    dst_item = await graph_get(config, dst.item())
    if "folder" in src_item and "folder" in dst_item:
        # GNU cp -r merges into an existing directory; Graph never merges
        # folders, so recurse per child instead.
        children = await graph_list(config, src.item("/children"))
        for child in children:
            name = child.get("name", "")
            await copy_tree(config, src.child(name), dst.child(name))
        return
    if "folder" in src_item or "folder" in dst_item:
        raise GraphError(409, code, message)
    await graph_delete(config, dst.item())
    err = await copy_once(config, src, dst)
    if err is not None:
        raise GraphError(500, err[0], err[1])
    await invalidate_after_write(dst.virt)


def _move_body(src: DriveLoc, dst: DriveLoc) -> dict:
    body: dict = {"name": posixpath.basename(dst.path)}
    if dst.parent() != src.parent() or src.drive != dst.drive:
        body["parentReference"] = {"path": dst.ref(dst.parent())}
    return body


async def rename_replace(config: MsGraphConfig, src: DriveLoc,
                         dst: DriveLoc) -> None:
    body = _move_body(src, dst)
    try:
        await graph_patch(config, src.item(), body)
    except GraphError as exc:
        if exc.status != 409 and exc.code != "nameAlreadyExists":
            raise
        # GNU mv overwrites the destination, but a Graph move has no
        # conflictBehavior that works across account types: drop the
        # conflicting file (or empty folder) and retry. A non-empty
        # folder conflict keeps the original error, mirroring mv's
        # "Directory not empty".
        dst_item = await graph_get(config, dst.item())
        if "folder" in dst_item:
            children = await graph_list(config, dst.item("/children"))
            if children:
                raise
        await graph_delete(config, dst.item())
        await graph_patch(config, src.item(), body)


async def create_child_folder(config: MsGraphConfig, parent_url: str,
                              name: str) -> None:
    body = {
        "name": name,
        "folder": {},
        "@microsoft.graph.conflictBehavior": "fail",
    }
    try:
        await graph_post(config, parent_url, body)
    except GraphError as exc:
        # mkdir is idempotent on object-store-style backends (matches the
        # s3 core); "replace" is unreliable for folders on real Graph, so
        # create with "fail" and tolerate the existing item.
        if exc.status != 409 and exc.code != "nameAlreadyExists":
            raise


async def upload_session_write(config: MsGraphConfig, session_url: str,
                               data: bytes) -> None:
    # createUploadSession defaults to "fail": without replace, overwriting
    # an existing file 409s on the final chunk.
    session = await graph_post(
        config, session_url,
        {"item": {
            "@microsoft.graph.conflictBehavior": "replace"
        }})
    upload_url = session["uploadUrl"]
    total = len(data)
    start = 0
    while start < total:
        chunk = data[start:start + UPLOAD_CHUNK]
        result = await upload_chunk(config, upload_url, chunk, start, total)
        ranges = result.get("nextExpectedRanges") if result else None
        if ranges:
            start = int(ranges[0].split("-", 1)[0])
        else:
            start += len(chunk)
