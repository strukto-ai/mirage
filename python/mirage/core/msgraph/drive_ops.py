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
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, replace
from urllib.parse import quote

import aiohttp

from mirage.cache.context import invalidate_after_write
from mirage.cache.index import IndexCacheStore, IndexEntry, ResourceType
from mirage.commands.builtin.find_eval import (FindEntry, PredNode, build_tree,
                                               emit_start_path, keep)
from mirage.core.msgraph._client import (GraphError, graph_delete, graph_get,
                                         graph_get_bytes, graph_list,
                                         graph_patch, graph_post,
                                         graph_post_monitor, graph_stream,
                                         new_session, poll_monitor,
                                         upload_chunk)
from mirage.core.msgraph.config import MsGraphConfig
from mirage.observe.context import (active_recorder, record, record_stream,
                                    revision_for)
from mirage.types import FileStat, FileType
from mirage.utils.errors import enoent
from mirage.utils.filetype import guess_type

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
        path = f"{self.path}/{name}" if self.path else name
        virt = f"{self.virt}/{name}" if self.virt else name
        return replace(self, path=path, virt=virt)

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


def _range_header(offset: int, size: int | None) -> str | None:
    if not offset and size is None:
        return None
    end = (offset + size - 1) if size is not None else ""
    return f"bytes={offset}-{end}"


def entry_stat(item: dict) -> FileStat:
    name = item.get("name", "")
    if "folder" in item:
        return FileStat(name=name,
                        type=FileType.DIRECTORY,
                        size=item.get("size"),
                        modified=item.get("lastModifiedDateTime"))
    return FileStat(
        name=name,
        size=item.get("size"),
        modified=item.get("lastModifiedDateTime"),
        type=guess_type(name),
        fingerprint=item.get("cTag"),
        extra={
            "id": item.get("id"),
            "ctag": item.get("cTag"),
            "etag": item.get("eTag"),
        },
    )


def current_version_id(versions: list[dict]) -> str | None:
    if not versions:
        return None
    current = max(versions, key=lambda v: v.get("lastModifiedDateTime") or "")
    return current.get("id")


async def capture_item_metadata(
        config: MsGraphConfig,
        loc: DriveLoc) -> tuple[str | None, str | None, str | None]:
    item = await graph_get(config, loc.item(), params={"$expand": "versions"})
    fingerprint = item.get("cTag")
    revision = current_version_id(item.get("versions", []))
    download_url = item.get("@microsoft.graph.downloadUrl")
    return fingerprint, revision, download_url


async def read_item(config: MsGraphConfig,
                    loc: DriveLoc,
                    virtual: str,
                    label: str,
                    backend: str,
                    offset: int = 0,
                    size: int | None = None) -> bytes:
    pinned = revision_for(virtual)
    range_header = _range_header(offset, size)
    start_ms = int(time.monotonic() * 1000)
    fingerprint = None
    revision = pinned
    try:
        if pinned:
            action = f"/versions/{quote(pinned, safe='')}/content"
            data = await graph_get_bytes(config, loc.item(action),
                                         range_header)
        elif active_recorder() is not None:
            fingerprint, revision, download_url = await capture_item_metadata(
                config, loc)
            if download_url:
                data = await graph_get_bytes(config,
                                             download_url,
                                             range_header,
                                             auth=False)
            else:
                data = await graph_get_bytes(config, loc.item("/content"),
                                             range_header)
        else:
            data = await graph_get_bytes(config, loc.item("/content"),
                                         range_header)
    except GraphError as exc:
        if exc.status == 404:
            raise enoent(virtual)
        raise
    record("read",
           label,
           backend,
           len(data),
           start_ms,
           fingerprint=fingerprint,
           revision=revision)
    return data


async def stream_item(config: MsGraphConfig,
                      loc: DriveLoc,
                      virtual: str,
                      label: str,
                      backend: str,
                      chunk_size: int = 8192) -> AsyncIterator[bytes]:
    pinned = revision_for(virtual)
    rec = record_stream("read", label, backend)
    url = loc.item("/content")
    auth = True
    try:
        if pinned is not None:
            url = loc.item(f"/versions/{quote(pinned, safe='')}/content")
            if rec is not None:
                rec.revision = pinned
        elif rec is not None:
            (rec.fingerprint, rec.revision,
             download_url) = await capture_item_metadata(config, loc)
            if download_url:
                url = download_url
                auth = False
        async for chunk in graph_stream(config, url, chunk_size, auth=auth):
            if rec is not None:
                rec.bytes += len(chunk)
            yield chunk
    except GraphError as exc:
        if exc.status == 404:
            raise enoent(virtual)
        raise


async def iter_tree(
    config: MsGraphConfig,
    loc: DriveLoc,
    session: aiohttp.ClientSession | None = None,
) -> AsyncIterator[tuple[str, dict, bool]]:
    children = await graph_list(config, loc.item("/children"), session=session)
    for child in children:
        cname = child.get("name", "")
        child_loc = loc.child(cname)
        is_dir = "folder" in child
        yield child_loc.path, child, is_dir
        if is_dir:
            async for entry in iter_tree(config, child_loc, session=session):
                yield entry


async def du_tree_total(config: MsGraphConfig, loc: DriveLoc) -> int:
    total = 0
    async with new_session(config) as session:
        async for _rel, item, is_dir in iter_tree(config, loc,
                                                  session=session):
            if not is_dir:
                total += item.get("size", 0)
    return total


async def du_tree_entries(config: MsGraphConfig,
                          loc: DriveLoc) -> list[tuple[str, int]]:
    results: list[tuple[str, int]] = []
    total = 0
    async with new_session(config) as session:
        async for rel, item, is_dir in iter_tree(config, loc, session=session):
            if is_dir:
                continue
            size = item.get("size", 0)
            results.append(("/" + rel, size))
            total += size
    results.append(("/" + loc.path if loc.path else "/", total))
    return results


async def find_items(
    config: MsGraphConfig,
    loc: DriveLoc,
    start_name: str,
    dir_exists: Callable[[], Awaitable[bool]],
    name: str | None = None,
    type: str | None = None,
    min_size: int | None = None,
    max_size: int | None = None,
    maxdepth: int | None = None,
    name_exclude: str | None = None,
    or_names: list[str] | None = None,
    iname: str | None = None,
    path_pattern: str | None = None,
    mindepth: int | None = None,
    empty: bool = False,
    tree: PredNode | None = None,
) -> list[str]:
    base = loc.path
    results: list[str] = []
    saw_descendant = False
    tree = tree if tree is not None else build_tree(name=name,
                                                    iname=iname,
                                                    path_pattern=path_pattern,
                                                    type=type,
                                                    name_exclude=name_exclude,
                                                    or_names=or_names,
                                                    empty=empty)
    async with new_session(config) as session:
        async for rel, item, is_dir in iter_tree(config, loc, session=session):
            relative = rel[len(base):].lstrip("/") if base else rel
            depth = relative.count("/") + 1
            if maxdepth is not None and depth > maxdepth:
                continue
            saw_descendant = True
            entry_name = rel.rsplit("/", 1)[-1]
            full_path = "/" + rel
            size = item.get("size", 0)
            is_empty = (None if not empty else
                        (size == 0 if not is_dir else False))
            entry = FindEntry(key=full_path,
                              name=entry_name,
                              kind="d" if is_dir else "f",
                              depth=depth,
                              is_empty=is_empty)
            if not keep(entry, tree, mindepth):
                continue
            if min_size is not None or max_size is not None:
                # Directories count as size 0 for -size (deliberate GNU
                # divergence).
                effective = 0 if is_dir else size
                if min_size is not None and effective < min_size:
                    continue
                if max_size is not None and effective > max_size:
                    continue
            results.append(full_path)
    exists = saw_descendant or await dir_exists()
    if exists:
        root_key = "/" + base if base else "/"
        emit_start_path(results,
                        root_key,
                        start_name,
                        kind="d",
                        is_empty=False if empty else None,
                        exists=True,
                        tree=tree,
                        maxdepth=maxdepth,
                        mindepth=mindepth,
                        min_size=min_size,
                        max_size=max_size)
    return sorted(results)


async def readdir_items(
        config: MsGraphConfig, loc: DriveLoc, index: IndexCacheStore,
        prefix: str, stripped: str, virtual_key: str,
        stat_fn: Callable[[], Awaitable[FileStat]]) -> list[str]:
    try:
        children = await graph_list(config, loc.item("/children"))
    except GraphError as exc:
        if exc.status != 404:
            raise
        info = await stat_fn()
        if info.type != FileType.DIRECTORY:
            raise NotADirectoryError(virtual_key) from exc
        raise enoent(virtual_key) from exc
    base = "/" + stripped if stripped else ""
    names: list[str] = []
    index_entries: list[tuple[str, IndexEntry]] = []
    for child in children:
        cname = child.get("name", "")
        key = f"{base}/{cname}"
        names.append(key)
        rtype = (ResourceType.FOLDER
                 if "folder" in child else ResourceType.FILE)
        index_entries.append(
            (cname,
             IndexEntry(id=key,
                        name=cname,
                        resource_type=rtype,
                        size=child.get("size"),
                        remote_time=child.get("lastModifiedDateTime", ""))))
    names = sorted(names)
    virtual_entries = sorted((prefix + e if prefix else e) for e in names)
    await index.set_dir(virtual_key, index_entries)
    return virtual_entries


async def stat_item(config: MsGraphConfig, loc: DriveLoc, virtual: str,
                    virtual_key: str, index: IndexCacheStore) -> FileStat:
    lookup = await index.get(virtual_key)
    if lookup.entry is not None:
        entry = lookup.entry
        if entry.resource_type == ResourceType.FOLDER:
            return FileStat(name=entry.name,
                            type=FileType.DIRECTORY,
                            size=entry.size,
                            modified=entry.remote_time or None)
        return FileStat(name=entry.name,
                        size=entry.size,
                        modified=entry.remote_time or None,
                        type=guess_type(entry.name))
    parent = virtual_key.rsplit("/", 1)[0] or "/"
    parent_listing = await index.list_dir(parent)
    if parent_listing.entries is not None:
        raise enoent(virtual)
    try:
        item = await graph_get(config, loc.item())
    except GraphError as exc:
        if exc.status == 404:
            raise enoent(virtual)
        raise
    return entry_stat(item)
