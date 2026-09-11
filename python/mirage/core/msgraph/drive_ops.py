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
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, replace
from functools import partial
from typing import Any, Protocol, TypeVar
from urllib.parse import quote

from mirage.accessor.base import Accessor
from mirage.cache.context import invalidate_after_write
from mirage.cache.index import (NULL_INDEX, IndexCacheStore, IndexEntry,
                                ResourceType)
from mirage.commands.builtin.find_eval import (FindEntry, PredNode, build_tree,
                                               emit_start_path, keep)
from mirage.core.api.client import SessionArg
from mirage.core.msgraph.client import (GraphError, graph_delete, graph_get,
                                        graph_get_bytes, graph_list,
                                        graph_patch, graph_post,
                                        graph_post_monitor, graph_stream,
                                        poll_monitor, session_scope,
                                        upload_chunk)
from mirage.core.msgraph.config import MsGraphConfig
from mirage.observe.context import (active_recorder, record, record_stream,
                                    revision_for, start_op)
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import enoent, listing_error
from mirage.utils.filetype import content_type_for_path
from mirage.utils.ranges import window_for

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

    def item_at(self, path: str, action: str = "") -> str:
        # Any item on the same drive, addressed the way this loc addresses
        # its own. The ancestor probes need it: a DriveLoc's `path` is
        # already spelled the way its url callable expects, so an ancestor
        # of that path is too.
        return self.url(path, action)

    def child(self, name: str) -> "DriveLoc":
        path = f"{self.path}/{name}" if self.path else name
        virt = f"{self.virt}/{name}" if self.virt else name
        return replace(self, path=path, virt=virt)

    def parent(self) -> str:
        return posixpath.dirname("/" + self.path).strip("/")


def _parent_reference(src: DriveLoc, dst: DriveLoc) -> dict[str, Any]:
    ref: dict[str, Any] = {"path": dst.ref(dst.parent())}
    if src.drive != dst.drive and dst.drive:
        ref["driveId"] = dst.drive
    return ref


def _virt_spec(loc: DriveLoc) -> PathSpec:
    # Cache invalidation takes a PathSpec; DriveLoc carries the
    # mount-relative spelling, which is exactly the resource_path.
    stripped = loc.virt.strip("/")
    return PathSpec.from_str_path("/" + stripped if stripped else "/",
                                  stripped)


async def copy_once(config: MsGraphConfig,
                    src: DriveLoc,
                    dst: DriveLoc,
                    session: SessionArg = None) -> tuple[str, str] | None:
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
        session (SessionArg): pool or live session to ride.

    Returns:
        tuple[str, str] | None: ``(code, message)`` of a failed copy, or
        None when the copy completed.
    """
    body = {
        "name": posixpath.basename(dst.path),
        "parentReference": _parent_reference(src, dst),
    }
    try:
        monitor = await graph_post_monitor(config,
                                           src.item("/copy"),
                                           body,
                                           session=session)
    except GraphError as exc:
        if exc.status == 409 or exc.code == "nameAlreadyExists":
            return exc.code, str(exc)
        raise
    result = await poll_monitor(monitor,
                                timeout=config.timeout,
                                session=session)
    status = result.get("status")
    if status == "failed":
        err = result.get("error", {}) if isinstance(result, dict) else {}
        return (err.get("code", "copyFailed"),
                err.get("message", f"copy {src.path} -> {dst.path} failed"))
    if status != "completed":
        raise GraphError(504, "copyTimeout",
                         f"copy {src.path} -> {dst.path} not confirmed")
    return None


async def copy_tree(config: MsGraphConfig,
                    src: DriveLoc,
                    dst: DriveLoc,
                    session: SessionArg = None) -> None:
    err = await copy_once(config, src, dst, session=session)
    if err is None:
        await invalidate_after_write(_virt_spec(dst))
        return
    code, message = err
    if code != "nameAlreadyExists":
        raise GraphError(500, code, message)
    src_item = await graph_get(config, src.item(), session=session)
    dst_item = await graph_get(config, dst.item(), session=session)
    if "folder" in src_item and "folder" in dst_item:
        # GNU cp -r merges into an existing directory; Graph never merges
        # folders, so recurse per child instead.
        children = await graph_list(config,
                                    src.item("/children"),
                                    session=session)
        for child in children:
            name = child.get("name", "")
            await copy_tree(config,
                            src.child(name),
                            dst.child(name),
                            session=session)
        return
    if "folder" in src_item or "folder" in dst_item:
        raise GraphError(409, code, message)
    await graph_delete(config, dst.item(), session=session)
    err = await copy_once(config, src, dst, session=session)
    if err is not None:
        raise GraphError(500, err[0], err[1])
    await invalidate_after_write(_virt_spec(dst))


def _move_body(src: DriveLoc, dst: DriveLoc) -> dict[str, Any]:
    body: dict[str, Any] = {"name": posixpath.basename(dst.path)}
    if dst.parent() != src.parent() or src.drive != dst.drive:
        body["parentReference"] = {"path": dst.ref(dst.parent())}
    return body


async def rename_replace(config: MsGraphConfig,
                         src: DriveLoc,
                         dst: DriveLoc,
                         session: SessionArg = None) -> None:
    body = _move_body(src, dst)
    try:
        await graph_patch(config, src.item(), body, session=session)
    except GraphError as exc:
        if exc.status != 409 and exc.code != "nameAlreadyExists":
            raise
        # GNU mv overwrites the destination, but a Graph move has no
        # conflictBehavior that works across account types: drop the
        # conflicting file (or empty folder) and retry. A non-empty
        # folder conflict keeps the original error, mirroring mv's
        # "Directory not empty".
        dst_item = await graph_get(config, dst.item(), session=session)
        if "folder" in dst_item:
            children = await graph_list(config,
                                        dst.item("/children"),
                                        session=session)
            if children:
                raise
        await graph_delete(config, dst.item(), session=session)
        await graph_patch(config, src.item(), body, session=session)


async def create_child_folder(config: MsGraphConfig,
                              parent_url: str,
                              name: str,
                              session: SessionArg = None) -> None:
    body = {
        "name": name,
        "folder": {},
        "@microsoft.graph.conflictBehavior": "fail",
    }
    try:
        await graph_post(config, parent_url, body, session=session)
    except GraphError as exc:
        # mkdir is idempotent on object-store-style backends (matches the
        # s3 core); "replace" is unreliable for folders on real Graph, so
        # create with "fail" and tolerate the existing item.
        if exc.status != 409 and exc.code != "nameAlreadyExists":
            raise


async def upload_session_write(config: MsGraphConfig,
                               session_url: str,
                               data: bytes,
                               session: SessionArg = None) -> None:
    # createUploadSession defaults to "fail": without replace, overwriting
    # an existing file 409s on the final chunk.
    created = await graph_post(
        config,
        session_url,
        {"item": {
            "@microsoft.graph.conflictBehavior": "replace"
        }},
        session=session)
    upload_url = created["uploadUrl"]
    total = len(data)
    start = 0
    while start < total:
        chunk = data[start:start + UPLOAD_CHUNK]
        result = await upload_chunk(config,
                                    upload_url,
                                    chunk,
                                    start,
                                    total,
                                    session=session)
        ranges = result.get("nextExpectedRanges") if result else None
        if ranges:
            start = int(ranges[0].split("-", 1)[0])
        else:
            start += len(chunk)


def folder_child_count(item: dict[str, Any]) -> int | None:
    """Child count from a driveItem's folder facet.

    Graph returns the facet's ``childCount`` by default, so ``-empty``
    needs no extra request. Absent (a ``$select`` that dropped it) reads
    as unknown.

    Args:
        item (dict): a Graph driveItem.
    """
    facet = item.get("folder")
    if not isinstance(facet, dict):
        return None
    count = facet.get("childCount")
    return count if isinstance(count, int) else None


def entry_stat(item: dict[str, Any]) -> FileStat:
    name = item.get("name", "")
    if "folder" in item:
        # Graph's folder `size` is aggregate storage metadata, not the
        # byte length of any rendered content: keep it out of
        # FileStat.size (see CLAUDE.md FUSE rules) and expose it as
        # extra["size_bytes"].
        return FileStat(name=name,
                        type=FileType.DIRECTORY,
                        modified=item.get("lastModifiedDateTime"),
                        extra={
                            "size_bytes": item.get("size"),
                            "child_count": folder_child_count(item),
                        })
    return FileStat(
        name=name,
        size=item.get("size"),
        modified=item.get("lastModifiedDateTime"),
        type=FileType.FILE,
        content=content_type_for_path(name),
        fingerprint=item.get("cTag"),
        extra={
            "id": item.get("id"),
            "ctag": item.get("cTag"),
            "etag": item.get("eTag"),
        },
    )


def current_version_id(versions: list[dict[str, Any]]) -> str | None:
    if not versions:
        return None
    current = max(versions, key=lambda v: v.get("lastModifiedDateTime") or "")
    return current.get("id")


async def capture_item_metadata(config: MsGraphConfig,
                                loc: DriveLoc,
                                session: SessionArg = None
                                ) -> tuple[str | None, str | None, str | None]:
    item = await graph_get(config,
                           loc.item(),
                           params={"$expand": "versions"},
                           session=session)
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
                    size: int | None = None,
                    session: SessionArg = None) -> bytes:
    pinned = revision_for(virtual)
    window = window_for(offset, size)
    timer = start_op()
    fingerprint = None
    revision = pinned
    try:
        if pinned:
            action = f"/versions/{quote(pinned, safe='')}/content"
            data = await graph_get_bytes(config,
                                         loc.item(action),
                                         window,
                                         session=session)
        elif active_recorder() is not None:
            fingerprint, revision, download_url = await capture_item_metadata(
                config, loc, session=session)
            if download_url:
                data = await graph_get_bytes(config,
                                             download_url,
                                             window,
                                             auth=False,
                                             session=session)
            else:
                data = await graph_get_bytes(config,
                                             loc.item("/content"),
                                             window,
                                             session=session)
        else:
            data = await graph_get_bytes(config,
                                         loc.item("/content"),
                                         window,
                                         session=session)
    except GraphError as exc:
        if exc.status == 404:
            raise enoent(virtual)
        raise
    record("read",
           label,
           backend,
           len(data),
           timer,
           fingerprint=fingerprint,
           revision=revision)
    return data


async def stream_item(config: MsGraphConfig,
                      loc: DriveLoc,
                      virtual: str,
                      label: str,
                      backend: str,
                      chunk_size: int = 8192,
                      session: SessionArg = None) -> AsyncIterator[bytes]:
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
             download_url) = await capture_item_metadata(config,
                                                         loc,
                                                         session=session)
            if download_url:
                url = download_url
                auth = False
        async for chunk in graph_stream(config,
                                        url,
                                        chunk_size,
                                        auth=auth,
                                        session=session):
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
    session: SessionArg = None,
) -> AsyncIterator[tuple[str, dict[str, Any], bool]]:
    children = await graph_list(config, loc.item("/children"), session=session)
    for child in children:
        cname = child.get("name", "")
        child_loc = loc.child(cname)
        is_dir = "folder" in child
        yield child_loc.virt, child, is_dir
        if is_dir:
            async for entry in iter_tree(config, child_loc, session=session):
                yield entry


async def du_tree_total(config: MsGraphConfig,
                        loc: DriveLoc,
                        session: SessionArg = None) -> int:
    total = 0
    async with session_scope(config, session) as sess:
        async for _rel, item, is_dir in iter_tree(config, loc, session=sess):
            if not is_dir:
                total += item.get("size", 0)
    return total


async def du_tree_entries(
        config: MsGraphConfig,
        loc: DriveLoc,
        session: SessionArg = None) -> tuple[list[tuple[str, int]], int]:
    """Per-file sizes under a drive item plus their total.

    Paths are mount-relative and leaf files only; the caller lifts them
    onto virtual paths and renders any roll-up line itself.

    Args:
        config (MsGraphConfig): Graph credentials and endpoint.
        loc (DriveLoc): the drive item to walk.
        session (SessionArg): pool or live session to ride.
    """
    results: list[tuple[str, int]] = []
    total = 0
    async with session_scope(config, session) as sess:
        async for rel, item, is_dir in iter_tree(config, loc, session=sess):
            if is_dir:
                continue
            size = item.get("size", 0)
            results.append(("/" + rel, size))
            total += size
    results.sort()
    return results, total


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
    depth_offset: int = 0,
    emit_start: bool = True,
    session: SessionArg = None,
) -> list[str]:
    """Walk a drive subtree and return the matching mount-relative keys.

    ``depth_offset`` and ``emit_start`` exist for callers that stack this
    walk under synthetic namespace levels (SharePoint's site and library
    directories): the offset shifts reported depths so ``-maxdepth`` and
    ``-mindepth`` count from the real start path, and ``emit_start``
    suppresses the per-library start path so only the caller's own start
    is emitted.

    Args:
        config (MsGraphConfig): Graph config.
        loc (DriveLoc): subtree root.
        start_name (str): basename of the start path, as find prints it.
        dir_exists (Callable): resolves whether the start is a directory.
        name (str | None): -name pattern.
        type (str | None): -type filter.
        min_size (int | None): inclusive lower size bound.
        max_size (int | None): inclusive upper size bound.
        maxdepth (int | None): -maxdepth.
        name_exclude (str | None): negated -name pattern.
        or_names (list[str] | None): -o'd -name patterns.
        iname (str | None): -iname pattern.
        path_pattern (str | None): -path pattern.
        mindepth (int | None): -mindepth.
        empty (bool): whether -empty is in effect.
        tree (PredNode | None): pre-built predicate tree.
        depth_offset (int): added to every reported depth.
        emit_start (bool): whether to emit the start path itself.
        session (SessionArg): pool or live session to ride.
    """
    base = loc.virt
    results: list[str] = []
    saw_descendant = False
    start_children = 0
    tree = tree if tree is not None else build_tree(name=name,
                                                    iname=iname,
                                                    path_pattern=path_pattern,
                                                    type=type,
                                                    name_exclude=name_exclude,
                                                    or_names=or_names,
                                                    empty=empty)
    async with session_scope(config, session) as sess:
        async for rel, item, is_dir in iter_tree(config, loc, session=sess):
            relative = rel[len(base):].lstrip("/") if base else rel
            rel_depth = relative.count("/") + 1
            depth = rel_depth + depth_offset
            if rel_depth == 1:
                start_children += 1
            if maxdepth is not None and depth > maxdepth:
                continue
            saw_descendant = True
            entry_name = rel.rsplit("/", 1)[-1]
            full_path = "/" + rel
            size = item.get("size", 0)
            is_empty = (None if not empty else (
                folder_child_count(item) == 0 if is_dir else size == 0))
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
    exists = emit_start and (saw_descendant or await dir_exists())
    if exists:
        root_key = "/" + base if base else "/"
        emit_start_path(results,
                        root_key,
                        start_name,
                        kind="d",
                        is_empty=start_children == 0 if empty else None,
                        exists=True,
                        tree=tree,
                        maxdepth=maxdepth,
                        mindepth=mindepth,
                        min_size=min_size,
                        max_size=max_size)
    return sorted(results)


async def drive_root_empty(config: MsGraphConfig,
                           loc: DriveLoc,
                           session: SessionArg = None) -> bool:
    """Whether a drive item has no children, in one request.

    One bounded page, not ``graph_list``: the answer is a yes/no, and
    ``graph_list`` follows every ``@odata.nextLink``, so asking it made
    a large folder download its whole listing to produce one boolean.
    ``$top`` through that helper is worse rather than better -- it only
    shrinks each page, so the walk pages more times, not fewer -- which
    is why this sends the request itself. ``$select`` drops a driveItem
    payload this never reads.

    Args:
        config (MsGraphConfig): Graph config.
        loc (DriveLoc): the folder to probe.
        session (SessionArg): pool or live session to ride.
    """
    page = await graph_get(config,
                           loc.item("/children"), {
                               "$top": 1,
                               "$select": "id"
                           },
                           session=session)
    children = page.get("value")
    return not (isinstance(children, list) and children)


async def _item_or_none(config: MsGraphConfig,
                        loc: DriveLoc,
                        path: str,
                        session: SessionArg = None) -> dict[str, Any] | None:
    """One drive item addressed off ``loc``, or None when Graph has none.

    Args:
        config (MsGraphConfig): Graph config.
        loc (DriveLoc): any loc on the drive being probed.
        path (str): drive path of the item to fetch.
        session (SessionArg): pool or live session to ride.
    """
    try:
        return await graph_get(config,
                               loc.item_at(path.strip("/")),
                               session=session)
    except GraphError as exc:
        if exc.status == 404:
            return None
        raise


async def _is_file(config: MsGraphConfig,
                   loc: DriveLoc,
                   path: str,
                   session: SessionArg = None) -> bool:
    item = await _item_or_none(config, loc, path, session=session)
    return item is not None and "folder" not in item


async def _is_dir(config: MsGraphConfig,
                  loc: DriveLoc,
                  path: str,
                  session: SessionArg = None) -> bool:
    item = await _item_or_none(config, loc, path, session=session)
    return item is not None and "folder" in item


async def readdir_items(config: MsGraphConfig,
                        loc: DriveLoc,
                        index: IndexCacheStore,
                        prefix: str,
                        stripped: str,
                        virtual_key: str,
                        session: SessionArg = None) -> list[str]:
    try:
        children = await graph_list(config,
                                    loc.item("/children"),
                                    session=session)
    except GraphError as exc:
        if exc.status != 404:
            raise
        # Graph 404s a children listing for a missing item and for one
        # under a file alike, so the errno comes from walking the
        # ancestors: one item request per component, on this failure
        # path only.
        raise await listing_error(
            virtual_key, loc.path,
            partial(_is_file, config, loc, session=session),
            partial(_is_dir, config, loc, session=session)) from exc
    base = "/" + stripped if stripped else ""
    names: list[str] = []
    index_entries: list[tuple[str, IndexEntry]] = []
    for child in children:
        cname = child.get("name", "")
        key = f"{base}/{cname}"
        names.append(key)
        is_dir = "folder" in child
        rtype = ResourceType.FOLDER if is_dir else ResourceType.FILE
        # Folder `size` is aggregate storage metadata, never rendered
        # content length: cache it as extra, not as the entry size.
        extra = ({
            "size_bytes": child.get("size"),
            "child_count": folder_child_count(child),
        } if is_dir else {})
        index_entries.append(
            (cname,
             IndexEntry(id=key,
                        name=cname,
                        resource_type=rtype,
                        size=None if is_dir else child.get("size"),
                        remote_time=child.get("lastModifiedDateTime", ""),
                        extra=extra)))
    names = sorted(names)
    virtual_entries = sorted((prefix + e if prefix else e) for e in names)
    await index.set_dir(virtual_key, index_entries)
    return virtual_entries


async def stat_item(config: MsGraphConfig,
                    loc: DriveLoc,
                    virtual: str,
                    virtual_key: str,
                    index: IndexCacheStore,
                    session: SessionArg = None) -> FileStat:
    lookup = await index.get(virtual_key)
    if lookup.entry is not None:
        entry = lookup.entry
        if entry.resource_type == ResourceType.FOLDER:
            return FileStat(name=entry.name,
                            type=FileType.DIRECTORY,
                            size=entry.size,
                            modified=entry.remote_time or None,
                            extra=dict(entry.extra))
        return FileStat(name=entry.name,
                        size=entry.size,
                        modified=entry.remote_time or None,
                        type=FileType.FILE,
                        content=content_type_for_path(entry.name),
                        extra=dict(entry.extra))
    parent = virtual_key.rsplit("/", 1)[0] or "/"
    parent_listing = await index.list_dir(parent)
    if parent_listing.entries is not None:
        raise enoent(virtual)
    try:
        item = await graph_get(config, loc.item(), session=session)
    except GraphError as exc:
        if exc.status == 404:
            raise enoent(virtual)
        raise
    return entry_stat(item)


A = TypeVar("A", bound=Accessor)
A_contra = TypeVar("A_contra", bound=Accessor, contravariant=True)


class StatFn(Protocol[A_contra]):

    def __call__(self,
                 accessor: A_contra,
                 path: PathSpec,
                 index: IndexCacheStore = ...) -> Awaitable[FileStat]:
        ...


class ExistsFn(Protocol[A_contra]):

    def __call__(self,
                 accessor: A_contra,
                 path: PathSpec,
                 index: IndexCacheStore = ...) -> Awaitable[bool]:
        ...


class ReadFn(Protocol[A_contra]):

    def __call__(self,
                 accessor: A_contra,
                 path: PathSpec,
                 index: IndexCacheStore = ...,
                 offset: int = ...,
                 size: int | None = ...) -> Awaitable[bytes]:
        ...


class WriteFn(Protocol[A_contra]):

    def __call__(self, accessor: A_contra, path: PathSpec,
                 data: bytes) -> Awaitable[None]:
        ...


class TruncateFn(Protocol[A_contra]):

    def __call__(self, accessor: A_contra, path: PathSpec,
                 length: int) -> Awaitable[None]:
        ...


def make_exists(stat: StatFn[A]) -> ExistsFn[A]:
    """Build the boolean existence probe over a drive backend's stat.

    Graph has no cheap HEAD for an item, so existence is a stat that
    tolerates ENOENT. Both drive backends address items differently but
    probe identically, so only their stat is injected.

    Args:
        stat (StatFn): the backend's stat.

    Returns:
        ExistsFn: the probe.
    """

    async def exists(accessor: A,
                     path: PathSpec,
                     index: IndexCacheStore = NULL_INDEX) -> bool:
        try:
            await stat(accessor, path, index)
            return True
        except FileNotFoundError:
            return False

    return exists


def make_truncate(read: ReadFn[A], write: WriteFn[A]) -> TruncateFn[A]:
    """Build read-slice-pad-rewrite truncation over a drive backend's IO.

    Graph exposes no truncate, so the whole item is rewritten. A missing
    item truncates to a fresh one, matching ``open(path, "w")``.

    Args:
        read (ReadFn): the backend's read_bytes.
        write (WriteFn): the backend's write_bytes.

    Returns:
        TruncateFn: the truncation.
    """

    async def truncate(accessor: A, path: PathSpec, length: int) -> None:
        try:
            data = await read(accessor, path, index=NULL_INDEX)
        except FileNotFoundError:
            data = b""
        await write(accessor, path, data[:length].ljust(length, b"\0"))

    return truncate
