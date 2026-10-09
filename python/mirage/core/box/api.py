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

from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any, TypeVar

from mirage.cache.context import stale
from mirage.cache.types import WriteCondition
from mirage.core.box.client import (
    BoxApiError,
    BoxTokenManager,
    box_delete,
    box_get,
    box_get_bytes,
    box_get_stream,
    box_options,
    box_post_json,
    box_put_json,
    box_upload_multipart,
)
from mirage.core.box.constants import GONE_STATUS, LOST_STATUS
from mirage.errors.fs import enoent
from mirage.errors.types import StaleWriteError
from mirage.types import JsonValue, PathSpec
from mirage.utils.ranges import ByteWindow

T = TypeVar("T")


async def absent_on_404(virtual: str, call: Callable[[], Awaitable[T]]) -> T:
    """Read Box's 404 as absence, leaving every other status a failure.

    Box answers a folder id that has been deleted, or was never
    reachable, with 404, and ``BoxApiError`` carries only an HTTP
    status. Stamping that one status as ENOENT here keeps a single
    definition of absence: stat, readdir and du's walk all read the
    POSIX error instead of sniffing a status, so a 401/429/5xx stays a
    failure rather than reading back as a missing path.

    Args:
        virtual (str): virtual path to name in the ENOENT.
        call (Callable[[], Awaitable[T]]): the Box call to run.

    Returns:
        T: whatever the call returned.
    """
    try:
        return await call()
    except BoxApiError as exc:
        if exc.status == 404:
            raise enoent(virtual) from exc
        raise


async def refused(
    path: PathSpec,
    exc: BoxApiError,
    cond: WriteCondition | None,
    etag: str | None,
) -> StaleWriteError | None:
    """The refusal a request sent with ``If-Match`` met, None for any other.

    Box answers 412 when the file changed since the etag sent and 404 when
    it is gone; anything else keeps its own meaning, as does any answer to
    a request that went plain.

    Args:
        path (PathSpec): the path the request wrote.
        exc (BoxApiError): Box's answer.
        cond (WriteCondition | None): the condition the write carried; its
            content token is the version a refusal keeps.
        etag (str | None): the etag sent as ``If-Match``, None if none.
    """
    if not etag:
        return None
    if exc.status == LOST_STATUS:
        return await stale(path, version=cond.if_match if cond else None)
    if exc.status == GONE_STATUS:
        return await stale(path, gone=True)
    return None


def if_match(etag: str | None) -> dict[str, str] | None:
    """The header that conditions a request on ``etag``, None to go plain.

    Args:
        etag (str | None): the file's etag, or None.
    """
    return {"If-Match": etag} if etag else None


LIST_FIELDS = "id,name,type,size,modified_at,etag,sha1,parent"
SEARCH_FIELDS = "id,name,type,path_collection"
ITEM_FIELDS = "type,id,name,size,modified_at,sha1,path_collection,item_status"
SEARCH_PAGE = 200
# Box search serves at most 10,000 matches across all pages; a result set
# that reaches the ceiling may be incomplete and must not narrow a scan.
MAX_SEARCH_MATCHES = 10_000
EVENTS_PAGE = 500


async def list_folder_items(
    tm: BoxTokenManager,
    folder_id: str,
    limit: int = 1000,
) -> list[dict[str, Any]]:
    """List every item in a Box folder, following offset pagination.

    Args:
        tm (BoxTokenManager): token manager.
        folder_id (str): Box folder id ("0" is All Files, the account root).
        limit (int): page size for each request.
    """
    out: list[dict[str, Any]] = []
    offset = 0
    while True:
        data = await box_get(
            tm,
            f"{tm.api_base}/folders/{folder_id}/items",
            params={
                "fields": LIST_FIELDS,
                "limit": limit,
                "offset": offset,
            },
        )
        entries = data.get("entries", [])
        out.extend(entries)
        offset += len(entries)
        if offset >= data.get("total_count", 0) or not entries:
            break
    return out


def _next_position(data: dict[str, Any]) -> str | None:
    value = data.get("next_stream_position")
    return None if value is None or value == "" else str(value)


async def events_now(tm: BoxTokenManager, stream_type: str) -> str:
    """The current head of the user's event stream.

    Args:
        tm (BoxTokenManager): token manager.
        stream_type (str): ``all``, ``changes`` or ``sync``.
    """
    data = await box_get(
        tm,
        f"{tm.api_base}/events",
        params={
            "stream_type": stream_type,
            "stream_position": "now",
        },
    )
    position = _next_position(data)
    if position is None:
        raise RuntimeError("Box GET /events returned no next_stream_position")
    return position


async def events_since(
    tm: BoxTokenManager,
    stream_position: str,
    stream_type: str,
    limit: int = EVENTS_PAGE,
) -> tuple[list[dict[str, Any]], str]:
    """Every user event after ``stream_position``, and the new position.

    Box may answer with fewer events than ``limit`` while more remain,
    so only an empty page ends the read. A page of events that does not
    move the position on is refused: reading it again would return the
    same page for as long as the server keeps answering that way.

    Args:
        tm (BoxTokenManager): token manager.
        stream_position (str): position from a previous read.
        stream_type (str): ``all``, ``changes`` or ``sync``.
        limit (int): events per request (Box caps it at 500).
    """
    out: list[dict[str, Any]] = []
    position = stream_position
    while True:
        data = await box_get(
            tm,
            f"{tm.api_base}/events",
            params={
                "stream_type": stream_type,
                "stream_position": position,
                "limit": limit,
            },
        )
        entries = data.get("entries") or []
        advanced = _next_position(data)
        if not entries:
            return out, advanced or position
        if advanced is None or advanced == position:
            raise RuntimeError(
                "Box GET /events returned events but did not "
                "advance next_stream_position"
            )
        out.extend(entries)
        position = advanced


async def realtime_server(tm: BoxTokenManager) -> dict[str, Any]:
    """The long-poll server for the user's event stream.

    ``OPTIONS /events`` hands back a ``realtime_server`` entry; a GET on
    its ``url`` with ``&stream_position=<position>`` blocks until Box
    answers ``new_change`` (read the events) or ``reconnect`` (ask for a
    new server). The loop is the caller's.

    Args:
        tm (BoxTokenManager): token manager.
    """
    data = await box_options(tm, f"{tm.api_base}/events")
    entries = data.get("entries") or []
    if not entries:
        raise RuntimeError("Box OPTIONS /events returned no realtime server")
    server: dict[str, Any] = entries[0]
    return server


async def get_folder_info(
    tm: BoxTokenManager, folder_id: str
) -> dict[str, Any]:
    return await box_get(tm, f"{tm.api_base}/folders/{folder_id}")


async def get_file_info(tm: BoxTokenManager, file_id: str) -> dict[str, Any]:
    """One file's live metadata: its sha1, name, ancestry and status.

    Args:
        tm (BoxTokenManager): token manager.
        file_id (str): Box file id.
    """
    return await box_get(
        tm, f"{tm.api_base}/files/{file_id}", params={"fields": ITEM_FIELDS}
    )


async def download_file(
    tm: BoxTokenManager, file_id: str, window: ByteWindow | None = None
) -> bytes:
    """Download a file's content, optionally only a byte range of it.

    Args:
        tm (BoxTokenManager): token manager.
        file_id (str): Box file id.
        window (ByteWindow | None): the byte window, or None for the
            whole file.
    """
    return await box_get_bytes(
        tm, f"{tm.api_base}/files/{file_id}/content", window=window
    )


def download_file_stream(
    tm: BoxTokenManager, file_id: str
) -> AsyncIterator[bytes]:
    return box_get_stream(tm, f"{tm.api_base}/files/{file_id}/content")


async def search_content(
    tm: BoxTokenManager,
    query: str,
    ancestor_folder_id: str,
) -> tuple[list[dict[str, Any]], bool]:
    """Name+content search scoped to a folder subtree.

    Pages Box `/search` with `ancestor_folder_ids` scoping and
    `content_types=name,file_content` so the query matches file names and the
    server-indexed body text. Each returned item carries `path_collection`
    (its ancestor chain) for mount-relative path reconstruction.

    Args:
        tm (BoxTokenManager): token manager.
        query (str): literal search query.
        ancestor_folder_id (str): folder id scoping the search to a subtree.

    Returns:
        tuple[list[dict[str, Any]], bool]: matched file items and whether the
            result reached the 10,000-match ceiling (a truncated set is not a
            trustworthy superset of a full walk).
    """
    out: list[dict[str, Any]] = []
    offset = 0
    while True:
        data = await box_get(
            tm,
            f"{tm.api_base}/search",
            params={
                "query": query,
                "ancestor_folder_ids": ancestor_folder_id,
                "content_types": "name,file_content",
                "type": "file",
                "fields": SEARCH_FIELDS,
                "limit": SEARCH_PAGE,
                "offset": offset,
            },
        )
        entries = data.get("entries", [])
        out.extend(entries)
        offset += len(entries)
        if len(out) >= MAX_SEARCH_MATCHES:
            return out, True
        if offset >= data.get("total_count", 0) or not entries:
            return out, False


async def upload_new_file(
    tm: BoxTokenManager, parent_id: str, name: str, data: bytes
) -> JsonValue:
    return await box_upload_multipart(
        tm,
        f"{tm.upload_base}/files/content",
        {"name": name, "parent": {"id": parent_id}},
        name,
        data,
    )


async def upload_file_version(
    tm: BoxTokenManager,
    file_id: str,
    name: str,
    data: bytes,
    etag: str | None = None,
) -> JsonValue:
    return await box_upload_multipart(
        tm,
        f"{tm.upload_base}/files/{file_id}/content",
        {"name": name},
        name,
        data,
        headers=if_match(etag),
    )


async def create_folder(
    tm: BoxTokenManager, parent_id: str, name: str
) -> dict[str, Any]:
    return await box_post_json(
        tm,
        f"{tm.api_base}/folders",
        {"name": name, "parent": {"id": parent_id}},
    )


async def delete_file(
    tm: BoxTokenManager, file_id: str, etag: str | None = None
) -> None:
    await box_delete(
        tm, f"{tm.api_base}/files/{file_id}", headers=if_match(etag)
    )


async def delete_web_link(tm: BoxTokenManager, link_id: str) -> None:
    await box_delete(tm, f"{tm.api_base}/web_links/{link_id}")


async def delete_folder(
    tm: BoxTokenManager, folder_id: str, recursive: bool = True
) -> None:
    await box_delete(
        tm,
        f"{tm.api_base}/folders/{folder_id}",
        params={"recursive": "true" if recursive else "false"},
    )


async def update_file(
    tm: BoxTokenManager,
    file_id: str,
    name: str | None = None,
    parent_id: str | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {}
    if name is not None:
        body["name"] = name
    if parent_id is not None:
        body["parent"] = {"id": parent_id}
    return await box_put_json(tm, f"{tm.api_base}/files/{file_id}", body)


async def update_folder(
    tm: BoxTokenManager,
    folder_id: str,
    name: str | None = None,
    parent_id: str | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {}
    if name is not None:
        body["name"] = name
    if parent_id is not None:
        body["parent"] = {"id": parent_id}
    return await box_put_json(tm, f"{tm.api_base}/folders/{folder_id}", body)


async def copy_file(
    tm: BoxTokenManager, file_id: str, parent_id: str, name: str | None = None
) -> dict[str, Any]:
    body: dict[str, Any] = {"parent": {"id": parent_id}}
    if name is not None:
        body["name"] = name
    return await box_post_json(tm, f"{tm.api_base}/files/{file_id}/copy", body)


async def copy_folder(
    tm: BoxTokenManager,
    folder_id: str,
    parent_id: str,
    name: str | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {"parent": {"id": parent_id}}
    if name is not None:
        body["name"] = name
    return await box_post_json(
        tm, f"{tm.api_base}/folders/{folder_id}/copy", body
    )
