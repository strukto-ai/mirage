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

import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from gridfs.errors import NoFile

from mirage.accessor.gridfs import GridFSAccessor
from mirage.core.gridfs.client import (bucket, delete_all, files_coll,
                                       iter_latest, latest_file, prefix_query)
from mirage.core.gridfs.constants import SCOPE_ERROR
from mirage.core.object_store.driver import (ChildEntry, FindHints, ObjectMeta,
                                             ObjectStoreDriver, TreeEntry)
from mirage.core.timeutil import to_iso_z

_COPY_CHUNK = 1024 * 1024


def glob_regex(pattern: str) -> str | None:
    """Translate a find -name glob into an anchored-safe regex fragment.

    Args:
        pattern (str): Glob pattern (``*``, ``?`` supported).

    Returns:
        str | None: Regex fragment matching one path segment, or None
        when the pattern uses character classes we do not translate
        (caller falls back to the unpushed prefix query; client-side
        ``keep()`` still applies the exact semantics).
    """
    if "[" in pattern or "]" in pattern:
        return None
    parts: list[str] = []
    for ch in pattern:
        if ch == "*":
            parts.append("[^/]*")
        elif ch == "?":
            parts.append("[^/]")
        else:
            parts.append(re.escape(ch))
    return "".join(parts)


def build_query(pfx: str, name: str | None, iname: str | None,
                type: str | None, min_size: int | None, max_size: int | None,
                pushdown: bool) -> dict[str, Any]:
    """Build the fs.files query, pushing filters server-side when exact.

    Every condition is a superset of the GNU semantics (directory markers
    always pass the size condition, unpushable globs fall back to the
    prefix scan), so the client-side ``keep()`` pass stays authoritative.

    Args:
        pfx (str): Key prefix of the start directory ("" for root).
        name (str | None): -name glob.
        iname (str | None): -iname glob.
        type (str | None): "f" or "d".
        min_size (int | None): Inclusive lower size bound.
        max_size (int | None): Inclusive upper size bound.
        pushdown (bool): False when a complex predicate tree is present;
            only the prefix condition is used then.
    """
    conds: list[dict[str, Any]] = []
    base = prefix_query(pfx)
    if base:
        conds.append(base)
    if pushdown:
        escaped = re.escape(pfx)
        for pat, options in ((name, ""), (iname, "i")):
            if pat is None:
                continue
            rx = glob_regex(pat)
            if rx is None:
                continue
            regex: dict[str, Any] = {
                "$regex": f"^{escaped}(.*/)?{rx}/?$",
            }
            if options:
                regex["$options"] = options
            conds.append({"filename": regex})
        if type == "f":
            conds.append({"filename": {"$not": {"$regex": "/$"}}})
        elif type == "d":
            conds.append({"filename": {"$regex": "/$"}})
        if min_size is not None or max_size is not None:
            size_cond: dict[str, Any] = {}
            if min_size is not None:
                size_cond["$gte"] = min_size
            if max_size is not None:
                size_cond["$lte"] = max_size
            # Directory markers ride through; the client-side
            # dirs-count-as-0 rule decides their fate.
            conds.append({
                "$or": [
                    {
                        "length": size_cond
                    },
                    {
                        "filename": {
                            "$regex": "/$"
                        }
                    },
                ]
            })
    if not conds:
        return {}
    if len(conds) == 1:
        return conds[0]
    return {"$and": conds}


def subtree_query(stem: str) -> dict[str, Any]:
    """Match the file at ``stem`` plus everything beneath it.

    Args:
        stem (str): backend key with no trailing slash.
    """
    if not stem:
        return {}
    return {
        "$or": [
            {
                "filename": stem
            },
            {
                "filename": {
                    "$regex": "^" + re.escape(stem + "/")
                }
            },
        ]
    }


def _key_prefix_of(accessor: GridFSAccessor) -> str:
    return accessor.config.key_prefix or ""


@asynccontextmanager
async def _connect(accessor: GridFSAccessor) -> AsyncIterator[GridFSAccessor]:
    # The motor client lives on the accessor; there is no per-op handle
    # to open or close.
    yield accessor


async def _list_children(conn: GridFSAccessor,
                         pfx: str) -> AsyncIterator[ChildEntry]:
    async for doc in iter_latest(conn, prefix_query(pfx)):
        fname = doc["filename"]
        if fname == pfx:
            yield ChildEntry(key=fname, kind="marker")
            continue
        relative = fname[len(pfx):]
        slash = relative.find("/")
        if slash == -1:
            upload = doc.get("uploadDate")
            yield ChildEntry(key=fname,
                             kind="f",
                             size=doc["length"],
                             modified=to_iso_z(upload) if upload else "")
        else:
            # A deeper filename or a "seg/" directory marker both imply
            # an immediate child directory (S3 CommonPrefixes
            # equivalent).
            yield ChildEntry(key=pfx + relative[:slash], kind="d")


async def _list_tree(conn: GridFSAccessor,
                     pfx: str) -> AsyncIterator[TreeEntry]:
    async for doc in iter_latest(conn, prefix_query(pfx)):
        upload = doc.get("uploadDate")
        yield TreeEntry(key=doc["filename"],
                        size=doc["length"],
                        modified=to_iso_z(upload) if upload else "")


async def _list_subtree(conn: GridFSAccessor,
                        stem: str) -> AsyncIterator[TreeEntry]:
    async for doc in iter_latest(conn, subtree_query(stem)):
        upload = doc.get("uploadDate")
        yield TreeEntry(key=doc["filename"],
                        size=doc["length"],
                        modified=to_iso_z(upload) if upload else "")


async def _iter_query(conn: GridFSAccessor,
                      query: dict[str, Any]) -> AsyncIterator[TreeEntry]:
    async for doc in iter_latest(conn, query):
        upload = doc.get("uploadDate")
        yield TreeEntry(key=doc["filename"],
                        size=doc["length"],
                        modified=to_iso_z(upload) if upload else "")


def _find_tree(conn: GridFSAccessor, pfx: str,
               hints: FindHints) -> tuple[AsyncIterator[TreeEntry], bool]:
    query = build_query(pfx, hints.name, hints.iname, hints.type,
                        hints.min_size, hints.max_size, hints.pushdown)
    return _iter_query(conn, query), query != prefix_query(pfx)


async def _head(conn: GridFSAccessor, key: str) -> ObjectMeta | None:
    doc = await latest_file(conn, key)
    if doc is None:
        return None
    revision = str(doc["_id"])
    upload = doc.get("uploadDate")
    return ObjectMeta(size=doc["length"],
                      modified=to_iso_z(upload) if upload else None,
                      fingerprint=revision,
                      revision=revision,
                      extra={"file_id": revision})


async def _get(conn: GridFSAccessor, key: str) -> bytes | None:
    doc = await latest_file(conn, key)
    if doc is None:
        return None
    out = await bucket(conn).open_download_stream(doc["_id"])
    try:
        data: bytes = await out.read(-1)
    finally:
        await out.close()
    return data


async def _put(conn: GridFSAccessor, key: str,
               data: bytes) -> ObjectMeta | None:
    # Uploads a new revision; older revisions stay in fs.files, so reads
    # pinned to an old revision _id keep working (GridFS-native
    # versioning). The new _id wins both keys of LATEST_SORT, so it is
    # what _head answers next, spelled the same way.
    oid = await bucket(conn).upload_from_stream(key, data)
    revision = str(oid)
    return ObjectMeta(size=len(data), fingerprint=revision, revision=revision)


async def _delete_file(conn: GridFSAccessor, key: str) -> None:
    # Removes every revision of the filename (rm semantics; mirrors S3's
    # delete_object, which also succeeds silently on a missing key).
    await delete_all(conn, {"filename": key})


async def _delete_prefix(conn: GridFSAccessor, pfx: str) -> None:
    await delete_all(conn, prefix_query(pfx))


async def _copy_file(conn: GridFSAccessor, src_key: str, dst_key: str) -> bool:
    # Copies the latest revision only (mirrors S3 copy_object), streamed
    # chunk-by-chunk so large files never buffer fully in memory.
    doc = await latest_file(conn, src_key)
    if doc is None:
        return False
    b = bucket(conn)
    out = await b.open_download_stream(doc["_id"])
    grid_in = b.open_upload_stream(dst_key)
    try:
        while True:
            chunk = await out.read(_COPY_CHUNK)
            if not chunk:
                break
            await grid_in.write(chunk)
    finally:
        await out.close()
        await grid_in.close()
    return True


async def _move_file(conn: GridFSAccessor, src_key: str, dst_key: str) -> bool:
    # Server-side: retag every revision's filename instead of copying
    # bytes, so the whole revision history moves with the file.
    if await latest_file(conn, src_key) is None:
        return False
    if dst_key != src_key:
        await delete_all(conn, {"filename": dst_key})
    await files_coll(conn).update_many({"filename": src_key},
                                       {"$set": {
                                           "filename": dst_key
                                       }})
    return True


async def _move_prefix(conn: GridFSAccessor, src_pfx: str,
                       dst_pfx: str) -> bool:
    """Retag every revision under ``src_pfx`` to sit under ``dst_pfx``.

    A directory is a filename prefix plus the zero-byte ``key/`` marker
    mkdir writes, and the prefix query returns both, so one pass moves
    the marker and the whole subtree together.

    Args:
        conn (GridFSAccessor): GridFS accessor.
        src_pfx (str): source key prefix, trailing slash included.
        dst_pfx (str): destination key prefix, trailing slash included.

    Returns:
        bool: whether any revision was found under the source prefix.
    """
    files = files_coll(conn)
    docs: list[dict[str, Any]] = []
    async for doc in files.find(prefix_query(src_pfx),
                                projection={
                                    "_id": 1,
                                    "filename": 1
                                }):
        docs.append(doc)
    if not docs:
        return False
    if dst_pfx != src_pfx:
        # Read the source docs before clearing the destination: on a
        # self-directed move the two queries select the same revisions,
        # and deleting first would drop what the retag is about to move.
        await delete_all(conn, prefix_query(dst_pfx))
    for doc in docs:
        await files.update_one({"_id": doc["_id"]}, {
            "$set": {
                "filename": f"{dst_pfx}{doc['filename'][len(src_pfx):]}"
            }
        })
    return True


async def _probe_prefix(conn: GridFSAccessor, pfx: str) -> bool:
    doc = await files_coll(conn).find_one(prefix_query(pfx),
                                          projection={"_id": 1})
    return doc is not None


def _is_not_found(exc: Exception) -> bool:
    return isinstance(exc, NoFile)


DRIVER: ObjectStoreDriver[GridFSAccessor, GridFSAccessor] = ObjectStoreDriver(
    vfs="gridfs",
    scope_error=SCOPE_ERROR,
    key_prefix_of=_key_prefix_of,
    connect=_connect,
    list_children=_list_children,
    list_tree=_list_tree,
    list_subtree=_list_subtree,
    head=_head,
    get=_get,
    put=_put,
    delete_file=_delete_file,
    delete_prefix=_delete_prefix,
    move_file=_move_file,
    move_prefix=_move_prefix,
    copy_file=_copy_file,
    probe_prefix=_probe_prefix,
    is_not_found=_is_not_found,
    find_tree=_find_tree,
)
