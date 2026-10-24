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

import asyncio
import logging
import posixpath
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, replace
from functools import partial
from typing import Any, Protocol, TypeVar

import aiohttp

from mirage.accessor.base import Accessor
from mirage.accessor.onedrive import OneDriveAccessor
from mirage.accessor.sharepoint import SharePointAccessor
from mirage.core.msgraph.client import (
    GraphError,
    cancel_upload,
    graph_batch,
    graph_delete,
    graph_get,
    graph_get_bytes,
    graph_list,
    graph_patch,
    graph_post,
    graph_post_monitor,
    graph_put_bytes,
    graph_stream,
    id_segment,
    poll_monitor,
    upload_chunk,
)
from mirage.core.msgraph.constants import BATCH_LIMIT
from mirage.errors.fs import eexist, enoent, enotdir, enotsup, listing_error
from mirage.io.spool import ByteSpool
from mirage.io.types import ByteSource
from mirage.observe.context import (
    active_recorder,
    record,
    record_stream,
    revision_for,
    start_op,
)
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.filetype import content_type_for_path
from mirage.utils.key_prefix import mount_prefix_of
from mirage.utils.ranges import window_for

logger = logging.getLogger(__name__)

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
        virt (str): Mount-relative path, which a walk names children by.
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


def directory_path(path: PathSpec) -> PathSpec:
    """The directory a listing names: a glob lists the folder it sits in.

    Args:
        path (PathSpec): the operand.
    """
    return path.dir if path.pattern else path


def virtual_key(path: PathSpec) -> str:
    """The mount-absolute path of a listing or an entry.

    Args:
        path (PathSpec): the path, a glob standing for its folder.
    """
    target = directory_path(path)
    prefix = mount_prefix_of(target.virtual, target.vfs_path)
    if target.vfs_path:
        return f"{prefix}/{target.vfs_path}"
    return prefix or "/"


async def copy_once(
    accessor: OneDriveAccessor | SharePointAccessor,
    src: DriveLoc,
    dst: DriveLoc,
) -> tuple[str, str] | None:
    """One Graph copy attempt, surfacing a conflict instead of raising.

    Graph copies default to ``fail`` on a name conflict and the
    ``@microsoft.graph.conflictBehavior=replace`` query parameter is
    files-only (and unsupported on OneDrive Consumer), so the caller
    resolves conflicts itself (delete-and-retry for files, per-child
    merge for folders).

    Args:
        accessor (OneDriveAccessor | SharePointAccessor): Graph accessor.
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
        monitor = await graph_post_monitor(accessor, src.item("/copy"), body)
    except GraphError as exc:
        if exc.status == 409 or exc.code == "nameAlreadyExists":
            return exc.code, str(exc)
        raise
    result = await poll_monitor(accessor, monitor)
    status = result.get("status")
    if status == "failed":
        err = result.get("error", {}) if isinstance(result, dict) else {}
        return (
            err.get("code", "copyFailed"),
            err.get("message", f"copy {src.path} -> {dst.path} failed"),
        )
    if status != "completed":
        raise GraphError(
            504, "copyTimeout", f"copy {src.path} -> {dst.path} not confirmed"
        )
    return None


async def copy_tree(
    accessor: OneDriveAccessor | SharePointAccessor,
    src: DriveLoc,
    dst: DriveLoc,
) -> None:
    err = await copy_once(accessor, src, dst)
    if err is None:
        return
    code, message = err
    if code != "nameAlreadyExists":
        raise GraphError(500, code, message)
    src_item = await graph_get(accessor, src.item())
    dst_item = await graph_get(accessor, dst.item())
    if "folder" in src_item and "folder" in dst_item:
        # GNU cp -r merges into an existing directory; Graph never merges
        # folders, so recurse per child instead.
        children = await graph_list(accessor, src.item("/children"))
        for child in children:
            name = child.get("name", "")
            await copy_tree(accessor, src.child(name), dst.child(name))
        return
    if "folder" in src_item or "folder" in dst_item:
        raise GraphError(409, code, message)
    await graph_delete(accessor, dst.item())
    err = await copy_once(accessor, src, dst)
    if err is not None:
        raise GraphError(500, err[0], err[1])


def _move_body(src: DriveLoc, dst: DriveLoc) -> dict[str, Any]:
    body: dict[str, Any] = {"name": posixpath.basename(dst.path)}
    if dst.parent() != src.parent() or src.drive != dst.drive:
        body["parentReference"] = {"path": dst.ref(dst.parent())}
    return body


@dataclass(frozen=True)
class MovedItem:
    """What a rename_replace moved, and what it replaced."""

    moved: dict[str, Any]
    replaced_non_file: bool


async def rename_replace(
    accessor: OneDriveAccessor | SharePointAccessor,
    src: DriveLoc,
    dst: DriveLoc,
) -> MovedItem:
    """Move ``src`` to ``dst``, replacing a file or an empty folder there.

    Args:
        accessor (OneDriveAccessor | SharePointAccessor): Graph accessor.
        src (DriveLoc): the item to move.
        dst (DriveLoc): where it lands.

    Returns:
        MovedItem: the moved driveItem and whether the move replaced
        something at ``dst`` that was not positively a file.
    """
    body = _move_body(src, dst)
    replaced_non_file = False
    try:
        moved = await graph_patch(accessor, src.item(), body)
    except GraphError as exc:
        if exc.status != 409 and exc.code != "nameAlreadyExists":
            raise
        # GNU mv overwrites the destination, but a Graph move has no
        # conflictBehavior that works across account types: drop the
        # conflicting file (or empty folder) and retry. A non-empty
        # folder conflict keeps the original error, mirroring mv's
        # "Directory not empty".
        dst_item = await graph_get(accessor, dst.item())
        if "folder" in dst_item:
            children = await graph_list(accessor, dst.item("/children"))
            if children:
                raise
        await graph_delete(accessor, dst.item())
        replaced_non_file = "file" not in dst_item
        moved = await graph_patch(accessor, src.item(), body)
    return MovedItem(
        moved=moved if isinstance(moved, dict) else {},
        replaced_non_file=replaced_non_file,
    )


async def _url_item(
    accessor: OneDriveAccessor | SharePointAccessor, url: str
) -> dict[str, Any] | None:
    try:
        return await graph_get(accessor, url)
    except GraphError as exc:
        if exc.status != 404:
            raise
        return None


@dataclass(frozen=True, slots=True)
class FolderTarget:
    """Where a folder create stands.

    Attributes:
        item (str): the folder's own item URL.
        parent (str): the parent's item URL.
        virtual (str): the path a refusal names.
    """

    item: str
    parent: str
    virtual: str


async def create_child_folder(
    accessor: OneDriveAccessor | SharePointAccessor,
    parent_url: str,
    name: str,
    target: FolderTarget,
    exist_ok: bool = True,
) -> None:
    """Create one folder, naming a refusal the way mkdir(2) does.

    "replace" is unreliable for folders on real Graph, so the create
    uses "fail" and reads its 409: a folder already holding the name is
    success when ``exist_ok`` (a level ``mkdir -p`` passes through) and
    EEXIST otherwise, so a folder another client made after the callers
    looked is still refused; a file holding it is EEXIST. Graph answers
    a create under a missing parent and under a file alike with 404, so
    the parent is looked up to tell ENOENT from ENOTDIR. Both lookups
    run on a refusal only.

    Args:
        accessor (OneDriveAccessor | SharePointAccessor): Graph accessor.
        parent_url (str): the parent's ``/children`` URL.
        name (str): the folder's name.
        target (FolderTarget): the folder, its parent and its name.
        exist_ok (bool): a folder already holding the name is success.
    """
    body = {
        "name": name,
        "folder": {},
        "@microsoft.graph.conflictBehavior": "fail",
    }
    try:
        await graph_post(accessor, parent_url, body)
    except GraphError as exc:
        if exc.status == 409 or exc.code == "nameAlreadyExists":
            taken = await _url_item(accessor, target.item)
            if exist_ok and (taken is None or "folder" in taken):
                return
            raise eexist(target.virtual) from exc
        if exc.status != 404:
            raise
        found = await _url_item(accessor, target.parent)
        if found is not None and "folder" not in found:
            raise enotdir(target.virtual) from exc
        raise enoent(target.virtual) from exc


async def upload_session_write(
    accessor: OneDriveAccessor | SharePointAccessor,
    session_url: str,
    data: bytes | ByteSpool,
) -> None:
    created = await graph_post(
        accessor,
        session_url,
        {"item": {"@microsoft.graph.conflictBehavior": "replace"}},
    )
    upload_url = created["uploadUrl"]
    total = data.size if isinstance(data, ByteSpool) else len(data)
    start = 0
    try:
        while start < total:
            chunk = (
                await data.read(start, UPLOAD_CHUNK)
                if isinstance(data, ByteSpool)
                else data[start : start + UPLOAD_CHUNK]
            )
            result = await upload_chunk(
                accessor, upload_url, chunk, start, total
            )
            ranges = result.get("nextExpectedRanges") if result else None
            next_start = (
                int(ranges[0].split("-", 1)[0])
                if ranges
                else start + len(chunk)
            )
            if next_start <= start or next_start > total:
                raise ValueError("Graph upload session made no progress")
            start = next_start
    except BaseException:
        try:
            await cancel_upload(accessor, upload_url)
        except Exception:
            logger.debug(
                "Could not cancel Graph upload session", exc_info=True
            )
        raise


async def write_item(
    accessor: OneDriveAccessor | SharePointAccessor,
    loc: DriveLoc,
    data: ByteSource,
) -> int:
    """Replace a drive item's content, creating it and its parents.

    A small body is one ``PUT``; anything past the simple-upload limit
    goes through an upload session. A stream is spooled first, so its
    size picks between the two.

    Args:
        accessor (OneDriveAccessor | SharePointAccessor): Graph accessor.
        loc (DriveLoc): the item to write.
        data (ByteSource): its new content, consumed once.

    Returns:
        int: how many bytes were written.
    """
    if not isinstance(data, bytes):
        async with ByteSpool() as spool:
            await spool.fill(data)
            if spool.size > SIMPLE_UPLOAD_MAX:
                await upload_session_write(
                    accessor, loc.item("/createUploadSession"), spool
                )
                return spool.size
            data = await spool.read(0, spool.size)
    if len(data) <= SIMPLE_UPLOAD_MAX:
        await graph_put_bytes(accessor, loc.item("/content"), data)
    else:
        await upload_session_write(
            accessor, loc.item("/createUploadSession"), data
        )
    return len(data)


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
        return FileStat(
            name=name,
            type=FileType.DIRECTORY,
            modified=item.get("lastModifiedDateTime"),
            extra={
                "size_bytes": item.get("size"),
                "child_count": folder_child_count(item),
            },
        )
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


async def capture_item_metadata(
    accessor: OneDriveAccessor | SharePointAccessor,
    loc: DriveLoc,
    versions: bool = True,
) -> tuple[str | None, str | None, str | None]:
    """The item's cTag, current version and download URL, in one GET.

    Callers fetch this before the bytes and download from the URL it
    returns. Graph can change the item between the two requests, and in
    this order a change can only pair an older token with newer bytes,
    which the next freshness probe sees as stale; the other order would
    label old bytes with the new token and serve them as fresh.

    Args:
        accessor (OneDriveAccessor | SharePointAccessor): Graph accessor.
        loc (DriveLoc): the drive item.
        versions (bool): also expand the version history for the current
            revision, which only a snapshot needs; without it the revision
            is None. Every shell line records, so only reads outside one
            (FUSE, a runtime's guest, ``ws.vfs``) skip it.
    """
    params = {"$expand": "versions"} if versions else None
    item = await graph_get(accessor, loc.item(), params=params)
    fingerprint = item.get("cTag")
    revision = current_version_id(item.get("versions", []))
    download_url = item.get("@microsoft.graph.downloadUrl")
    return fingerprint, revision, download_url


async def read_item(
    accessor: OneDriveAccessor | SharePointAccessor,
    loc: DriveLoc,
    virtual: str,
    backend: str,
    offset: int = 0,
    size: int | None = None,
) -> bytes:
    pinned = revision_for(virtual)
    window = window_for(offset, size)
    timer = start_op()
    fingerprint = None
    revision = pinned
    try:
        if pinned:
            action = f"/versions/{id_segment(pinned)}/content"
            data = await graph_get_bytes(accessor, loc.item(action), window)
        else:
            fingerprint, revision, download_url = await capture_item_metadata(
                accessor,
                loc,
                versions=active_recorder() is not None,
            )
            if download_url:
                data = await graph_get_bytes(
                    accessor, download_url, window, auth=False
                )
            else:
                data = await graph_get_bytes(
                    accessor, loc.item("/content"), window
                )
    except GraphError as exc:
        if exc.status == 404:
            raise enoent(virtual)
        raise
    record(
        "read",
        virtual,
        backend,
        len(data),
        timer,
        fingerprint=fingerprint,
        revision=revision,
    )
    return data


async def stream_item(
    accessor: OneDriveAccessor | SharePointAccessor,
    loc: DriveLoc,
    virtual: str,
    backend: str,
    chunk_size: int = 8192,
) -> AsyncIterator[bytes]:
    pinned = revision_for(virtual)
    rec = record_stream("read", virtual, backend)
    url = loc.item("/content")
    auth = True
    try:
        if pinned is not None:
            url = loc.item(f"/versions/{id_segment(pinned)}/content")
            if rec is not None:
                rec.revision = pinned
        elif rec is not None:
            (
                rec.fingerprint,
                rec.revision,
                download_url,
            ) = await capture_item_metadata(accessor, loc, versions=True)
            if download_url:
                url = download_url
                auth = False
        async for chunk in graph_stream(accessor, url, chunk_size, auth=auth):
            if rec is not None:
                rec.bytes += len(chunk)
            yield chunk
    except GraphError as exc:
        if exc.status == 404:
            raise enoent(virtual)
        raise


async def iter_tree(
    accessor: OneDriveAccessor | SharePointAccessor, loc: DriveLoc
) -> AsyncIterator[tuple[str, dict[str, Any], bool]]:
    children = await graph_list(accessor, loc.item("/children"))
    for child in children:
        cname = child.get("name", "")
        child_loc = loc.child(cname)
        is_dir = "folder" in child
        yield child_loc.virt, child, is_dir
        if is_dir:
            async for entry in iter_tree(accessor, child_loc):
                yield entry


def parent_id(item: dict[str, Any]) -> str:
    """The id of the folder a driveItem sits in, "" when it names none.

    Args:
        item (dict[str, Any]): a driveItem, from a listing or a ``/delta``
            feed.
    """
    return str((item.get("parentReference") or {}).get("id") or "")


async def delta_tree(
    accessor: OneDriveAccessor | SharePointAccessor, loc: DriveLoc
) -> dict[str, FileStat] | None:
    """Every item under a folder, each as a listing's stat renders it, from
    one read of Graph's ``/delta`` feed started at that folder.

    One request asks the folder for its id, then the feed lists every item
    below it a page at a time, where a walk sends a listing per folder. The
    feed names an item by id with its name and its parent's id, never its
    path, and may list one more than once (its last row is its state), so
    each is placed by its parents up to the folder. An item under one a
    listing shows as a file (a package's contents) is left out, as a
    listing of that file would leave it. None when no folder is at
    ``loc``, so the walk's readdir reports what is there, when Graph
    refuses the feed, when the feed does not list the folder the first
    request found (another folder took its path in between, and the feed
    describes that one), when the feed holds a folder shared from another
    drive, whose items only that drive's feed lists, and when a file comes
    without the ``cTag`` its listing row carries (OneDrive for Business
    and SharePoint leave it out of the feed), since the mount keeps the
    answer as the folders' listings.

    Args:
        accessor (OneDriveAccessor | SharePointAccessor): Graph accessor.
        loc (DriveLoc): the folder.
    """
    try:
        top = await graph_get(accessor, loc.item(), {"$select": "id,folder"})
    except GraphError as exc:
        if exc.status != 404:
            raise
        logger.debug("graph tree of %s left to the walk: %s", loc.path, exc)
        return None
    top_id = top.get("id")
    if "folder" not in top or not isinstance(top_id, str):
        return None
    try:
        rows = await graph_list(accessor, loc.item("/delta"))
    except GraphError as exc:
        logger.debug("graph feed of %s left to the walk: %s", loc.path, exc)
        return None
    items: dict[str, dict[str, Any]] = {}
    for item in rows:
        if isinstance(item, dict) and isinstance(item.get("id"), str):
            items.pop(item["id"], None)
            items[item["id"]] = item
    folders = {
        item_id: item
        for item_id, item in items.items()
        if "folder" in item and "deleted" not in item
    }
    if (
        top_id not in folders
        or any(_remote_folder(item) for item in folders.values())
        or any(
            "file" in item and "deleted" not in item and not item.get("cTag")
            for item in items.values()
        )
    ):
        return None
    places: dict[str, str | None] = {top_id: ""}
    found: dict[str, FileStat] = {}
    for item_id, item in items.items():
        name = item.get("name")
        if (
            item_id == top_id
            or "deleted" in item
            or "root" in item
            or not isinstance(name, str)
            or not name
        ):
            continue
        base = _placed(parent_id(item), folders, places)
        if base is not None:
            found[f"{base}/{name}" if base else name] = entry_stat(item)
    return found


async def batch_tree(
    accessor: OneDriveAccessor | SharePointAccessor,
    loc: DriveLoc,
    virtual_key: str,
) -> dict[str, FileStat] | None:
    """Every item under a folder, each as its folder's listing renders it,
    from the folders' listings sent ``BATCH_LIMIT`` to a request through
    Graph's JSON batching, where a walk sends a request per folder.

    The folder's own children are its listing (``readdir_items``), so a
    folder that is not there raises what a listing raises. A listing the
    batch does not answer with its first page (Graph throttled or failed
    that one) is asked on its own, once the longest wait the batch's
    answers asked for has passed since it arrived (one wait a batch, each
    answer's counted from the same moment), and a listing's later pages
    are read as a listing reads them. None
    when Graph refuses a batch, or when a listing below the folder fails
    (a folder gone, or one the account may not open), so the walk lists
    what is there and reports, or skips, each folder on its own.

    Args:
        accessor (OneDriveAccessor | SharePointAccessor): Graph accessor.
        loc (DriveLoc): the folder.
        virtual_key (str): its mount-absolute path, which an error names.
    """
    found: dict[str, FileStat] = {}
    rows = await readdir_items(accessor, loc, virtual_key)
    level = _filed(found, "", loc, rows)
    while level:
        below: list[tuple[str, DriveLoc]] = []
        for start in range(0, len(level), BATCH_LIMIT):
            chunk = level[start : start + BATCH_LIMIT]
            urls = [folder.item("/children") for _, folder in chunk]
            try:
                answers = await graph_batch(accessor, urls)
                pause = max(
                    (wait for status, _, wait in answers if status != 200),
                    default=0.0,
                )
                if pause:
                    await asyncio.sleep(pause)
                listed = [
                    await _batch_page(accessor, url, status, body)
                    for url, (status, body, _) in zip(urls, answers)
                ]
            except (GraphError, aiohttp.ClientError, OSError) as exc:
                logger.debug(
                    "graph tree of %s left to the walk: %s", loc.path, exc
                )
                return None
            for (rel, folder), items in zip(chunk, listed):
                rows = sorted(map(entry_stat, items), key=lambda r: r.name)
                below.extend(_filed(found, rel, folder, rows))
        level = below
    return found


async def _batch_page(
    accessor: OneDriveAccessor | SharePointAccessor,
    url: str,
    status: int,
    body: dict[str, Any],
) -> list[dict[str, Any]]:
    """A folder's whole listing from its answer in a batch: the page the
    batch held and the pages after it, or the listing asked again on its
    own when the batch did not answer it.

    Args:
        accessor (OneDriveAccessor | SharePointAccessor): Graph accessor.
        url (str): the listing's URL.
        status (int): the answer's status.
        body (dict[str, Any]): the answer's body.
    """
    if status != 200:
        return await graph_list(accessor, url)
    value = body.get("value")
    items = [
        item
        for item in (value if isinstance(value, list) else [])
        if isinstance(item, dict)
    ]
    rest = body.get("@odata.nextLink")
    if isinstance(rest, str):
        items.extend(await graph_list(accessor, rest))
    return items


def _filed(
    found: dict[str, FileStat],
    rel: str,
    folder: DriveLoc,
    rows: list[FileStat],
) -> list[tuple[str, DriveLoc]]:
    """Put a folder's rows into a tree read, and answer the folders among
    them, each by its path below the read with its own address.

    Args:
        found (dict[str, FileStat]): the tree read so far.
        rel (str): the folder's path below the read, "" for its top.
        folder (DriveLoc): the folder.
        rows (list[FileStat]): its listing.
    """
    folders: list[tuple[str, DriveLoc]] = []
    for row in rows:
        key = f"{rel}/{row.name}" if rel else row.name
        found[key] = row
        if row.type is FileType.DIRECTORY:
            folders.append((key, folder.child(row.name)))
    return folders


def _remote_folder(item: dict[str, Any]) -> bool:
    """Whether a feed item is a folder kept on another drive.

    Args:
        item (dict[str, Any]): one ``/delta`` item.
    """
    remote = item.get("remoteItem")
    return isinstance(remote, dict) and "folder" in remote


def _placed(
    folder: str,
    folders: dict[str, dict[str, Any]],
    places: dict[str, str | None],
) -> str | None:
    """A folder's path below the top of a ``/delta`` read, None when its
    parents never reach it; each folder looked at is kept in ``places``.

    Args:
        folder (str): the folder's id.
        folders (dict[str, dict[str, Any]]): every live folder the feed
            listed, by id.
        places (dict[str, str | None]): the paths found so far, the top
            folder's "" among them.
    """
    chain: list[str] = []
    seen: set[str] = set()
    current = folder
    while current not in places:
        item = folders.get(current)
        if item is None or current in seen:
            places[current] = None
            break
        chain.append(current)
        seen.add(current)
        current = parent_id(item)
    base = places[current]
    for link in reversed(chain):
        if base is not None:
            name = str(folders[link].get("name") or "")
            base = f"{base}/{name}" if base and name else name or None
        places[link] = base
    return places[folder]


async def drive_root_empty(
    accessor: OneDriveAccessor | SharePointAccessor, loc: DriveLoc
) -> bool:
    """Whether a drive item has no children, in one request.

    One bounded page, not ``graph_list``: the answer is a yes/no, and
    ``graph_list`` follows every ``@odata.nextLink``, so asking it made
    a large folder download its whole listing to produce one boolean.
    ``$top`` through that helper is worse rather than better -- it only
    shrinks each page, so the walk pages more times, not fewer -- which
    is why this sends the request itself. ``$select`` drops a driveItem
    payload this never reads.

    Args:
        accessor (OneDriveAccessor | SharePointAccessor): Graph accessor.
        loc (DriveLoc): the folder to probe.
    """
    page = await graph_get(
        accessor, loc.item("/children"), {"$top": 1, "$select": "id"}
    )
    children = page.get("value")
    return not (isinstance(children, list) and children)


async def _item_or_none(
    accessor: OneDriveAccessor | SharePointAccessor, loc: DriveLoc, path: str
) -> dict[str, Any] | None:
    """One drive item addressed off ``loc``, or None when Graph has none.

    Args:
        accessor (OneDriveAccessor | SharePointAccessor): Graph accessor.
        loc (DriveLoc): any loc on the drive being probed.
        path (str): drive path of the item to fetch.
    """
    try:
        return await graph_get(accessor, loc.item_at(path.strip("/")))
    except GraphError as exc:
        if exc.status == 404:
            return None
        raise


async def _is_file(
    accessor: OneDriveAccessor | SharePointAccessor, loc: DriveLoc, path: str
) -> bool:
    item = await _item_or_none(accessor, loc, path)
    return item is not None and "folder" not in item


async def _is_dir(
    accessor: OneDriveAccessor | SharePointAccessor, loc: DriveLoc, path: str
) -> bool:
    item = await _item_or_none(accessor, loc, path)
    return item is not None and "folder" in item


async def readdir_items(
    accessor: OneDriveAccessor | SharePointAccessor,
    loc: DriveLoc,
    virtual_key: str,
) -> list[FileStat]:
    """A folder's children, each as ``stat`` answers it.

    Args:
        accessor (OneDriveAccessor | SharePointAccessor): Graph accessor.
        loc (DriveLoc): the folder.
        virtual_key (str): its mount-absolute path, which an error names.
    """
    try:
        children = await graph_list(accessor, loc.item("/children"))
    except GraphError as exc:
        if exc.status != 404:
            raise
        # Graph 404s a children listing for a missing item and for one
        # under a file alike, so the errno comes from walking the
        # ancestors: one item request per component, on this failure
        # path only.
        raise await listing_error(
            virtual_key,
            loc.path,
            partial(_is_file, accessor, loc),
            partial(_is_dir, accessor, loc),
        ) from exc
    rows = [entry_stat(child) for child in children]
    rows.sort(key=lambda row: row.name)
    return rows


async def stat_item(
    accessor: OneDriveAccessor | SharePointAccessor,
    loc: DriveLoc,
    virtual: str,
) -> FileStat:
    """One drive item's stat, from Graph.

    Args:
        accessor (OneDriveAccessor | SharePointAccessor): Graph accessor.
        loc (DriveLoc): the item.
        virtual (str): its virtual path, which an error names.
    """
    try:
        item = await graph_get(accessor, loc.item())
    except GraphError as exc:
        if exc.status == 404:
            raise enoent(virtual)
        raise
    return entry_stat(item)


A = TypeVar("A", bound=Accessor)
A_contra = TypeVar("A_contra", bound=Accessor, contravariant=True)


class StatFn(Protocol[A_contra]):
    def __call__(
        self, accessor: A_contra, path: PathSpec
    ) -> Awaitable[FileStat]: ...


class ExistsFn(Protocol[A_contra]):
    def __call__(
        self, accessor: A_contra, path: PathSpec
    ) -> Awaitable[bool]: ...


class ReadFn(Protocol[A_contra]):
    def __call__(
        self,
        accessor: A_contra,
        path: PathSpec,
        offset: int = ...,
        size: int | None = ...,
    ) -> Awaitable[bytes]: ...


class WriteFn(Protocol[A_contra]):
    def __call__(
        self, accessor: A_contra, path: PathSpec, data: bytes
    ) -> Awaitable[None]: ...


class TruncateFn(Protocol[A_contra]):
    def __call__(
        self,
        accessor: A_contra,
        path: PathSpec,
        length: int,
        no_create: bool = False,
    ) -> Awaitable[None]: ...


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

    async def exists(accessor: A, path: PathSpec) -> bool:
        try:
            await stat(accessor, path)
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

    async def truncate(
        accessor: A, path: PathSpec, length: int, no_create: bool = False
    ) -> None:
        if no_create:
            raise enotsup("msgraph", "truncate --no-create", path)
        try:
            data = await read(accessor, path)
        except FileNotFoundError:
            data = b""
        await write(accessor, path, data[:length].ljust(length, b"\0"))

    return truncate
