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

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

from mirage.accessor.s3 import S3Accessor, S3Config
from mirage.core.object_store.driver import (ChildEntry, ObjectMeta,
                                             ObjectStoreDriver, TreeEntry)
from mirage.core.s3.client import (_client_kwargs, async_session, closing_body,
                                   is_not_found)
from mirage.core.s3.constants import SCOPE_ERROR
from mirage.core.timeutil import to_iso_z

DELETE_BATCH = 1000


@dataclass(frozen=True, slots=True)
class S3Conn:
    """One open S3 client plus the config that shaped it.

    Args:
        client (Any): open aioboto3 S3 client.
        config (S3Config): the accessor's config.
    """
    client: Any
    config: S3Config


def _key_prefix_of(accessor: S3Accessor) -> str:
    return accessor.config.key_prefix or ""


@asynccontextmanager
async def _connect(accessor: S3Accessor) -> AsyncIterator[S3Conn]:
    # The client lives on the accessor and is closed with it, which is what
    # the driver contract means by "a store holding a live client on its
    # accessor". Opening one per operation cost ~49ms against ~2ms for a
    # reused one, so a battery of small ops paid the client, not the request.
    client = await accessor.cached_client(lambda: async_session(
        accessor.config).client(**_client_kwargs(accessor.config)))
    yield S3Conn(client=client, config=accessor.config)


async def _list_children(conn: S3Conn, pfx: str) -> AsyncIterator[ChildEntry]:
    paginator = conn.client.get_paginator("list_objects_v2")
    async for page in paginator.paginate(Bucket=conn.config.bucket,
                                         Prefix=pfx,
                                         Delimiter="/"):
        for cp in page.get("CommonPrefixes") or []:
            child = cp["Prefix"].rstrip("/")
            if child:
                yield ChildEntry(key=child, kind="d")
            else:
                yield ChildEntry(key=cp["Prefix"], kind="marker")
        for obj in page.get("Contents") or []:
            relative = obj["Key"][len(pfx):]
            if relative and "/" not in relative:
                last_mod = obj.get("LastModified")
                yield ChildEntry(
                    key=obj["Key"],
                    kind="f",
                    size=obj.get("Size"),
                    modified=to_iso_z(last_mod) if last_mod else "")
            else:
                yield ChildEntry(key=obj["Key"], kind="marker")


async def _list_tree(conn: S3Conn, pfx: str) -> AsyncIterator[TreeEntry]:
    paginator = conn.client.get_paginator("list_objects_v2")
    async for page in paginator.paginate(Bucket=conn.config.bucket,
                                         Prefix=pfx):
        for obj in page.get("Contents") or []:
            yield TreeEntry(key=obj["Key"],
                            size=obj.get("Size", 0),
                            modified=to_iso_z(obj["LastModified"])
                            if obj.get("LastModified") else "")


async def _list_subtree(conn: S3Conn, stem: str) -> AsyncIterator[TreeEntry]:
    # The prefix listing also matches sibling keys sharing the stem as a
    # name prefix ("data-old" under stem "data"), so each key is checked
    # against the exact stem or the slashed subtree.
    base = (stem + "/") if stem else ""
    paginator = conn.client.get_paginator("list_objects_v2")
    async for page in paginator.paginate(Bucket=conn.config.bucket,
                                         Prefix=stem):
        for obj in page.get("Contents") or []:
            okey = obj["Key"]
            if not (okey == stem or okey.startswith(base)):
                continue
            yield TreeEntry(key=okey,
                            size=obj.get("Size", 0),
                            modified=to_iso_z(obj["LastModified"])
                            if obj.get("LastModified") else "")


def _etag_of(resp: dict[str, Any]) -> str:
    """Quote-stripped ETag from a head or put response, "" when absent.

    Returned as a possibly-empty str rather than ``str | None`` because
    ``_head`` needs both spellings: ``fingerprint`` drops an empty one
    while ``extra`` carries it verbatim, and a helper that folded "" to
    None would change ``FileStat.extra``'s shape.

    Args:
        resp (dict[str, Any]): the head_object or put_object response.
    """
    return str(resp.get("ETag") or "").strip('"')


def _version_of(resp: dict[str, Any]) -> str | None:
    """VersionId from a head or put response, None when unversioned.

    Args:
        resp (dict[str, Any]): the head_object or put_object response.
    """
    vid = resp.get("VersionId")
    return None if vid in (None, "", "null") else str(vid)


async def _head(conn: S3Conn, key: str) -> ObjectMeta | None:
    try:
        resp = await conn.client.head_object(Bucket=conn.config.bucket,
                                             Key=key)
    except Exception as exc:
        if is_not_found(exc):
            return None
        raise
    etag_raw = _etag_of(resp)
    return ObjectMeta(size=resp["ContentLength"],
                      modified=to_iso_z(resp["LastModified"]),
                      fingerprint=etag_raw or None,
                      revision=_version_of(resp),
                      extra={"etag": etag_raw})


async def _get(conn: S3Conn, key: str) -> bytes | None:
    try:
        resp = await conn.client.get_object(Bucket=conn.config.bucket, Key=key)
    except Exception as exc:
        if is_not_found(exc):
            return None
        raise
    async with closing_body(resp["Body"]) as body:
        data: bytes = await body.read()
    return data


async def _put(conn: S3Conn, key: str, data: bytes) -> ObjectMeta | None:
    # The ETag is read through the same helper _head uses, so the token a
    # write stamps and the token a later stat reports are one spelling.
    resp = await conn.client.put_object(Bucket=conn.config.bucket,
                                        Key=key,
                                        Body=data)
    return ObjectMeta(size=len(data),
                      fingerprint=_etag_of(resp) or None,
                      revision=_version_of(resp))


async def _delete_file(conn: S3Conn, key: str) -> None:
    await conn.client.delete_object(Bucket=conn.config.bucket, Key=key)


async def _delete_prefix(conn: S3Conn, pfx: str) -> None:
    paginator = conn.client.get_paginator("list_objects_v2")
    async for page in paginator.paginate(Bucket=conn.config.bucket,
                                         Prefix=pfx):
        keys = [{"Key": obj["Key"]} for obj in page.get("Contents") or []]
        if keys:
            await conn.client.delete_objects(Bucket=conn.config.bucket,
                                             Delete={"Objects": keys})


async def _copy_file(conn: S3Conn, src_key: str, dst_key: str) -> bool:
    await conn.client.copy_object(Bucket=conn.config.bucket,
                                  CopySource={
                                      "Bucket": conn.config.bucket,
                                      "Key": src_key
                                  },
                                  Key=dst_key)
    return True


async def _move_file(conn: S3Conn, src_key: str, dst_key: str) -> bool:
    # The source is classified before anything is copied rather than by
    # letting copy_object fail: stores disagree about a missing source
    # (S3 and MinIO even spell the code differently, and a lenient
    # S3-compatible store accepts the copy and writes nothing), and on
    # that last one an error-driven fallback would delete a source whose
    # copy never landed. Only a classified not-found answers False; every
    # other failure propagates rather than reading as a directory.
    try:
        await conn.client.head_object(Bucket=conn.config.bucket, Key=src_key)
    except Exception as exc:
        if not is_not_found(exc):
            raise
        return False
    await _copy_file(conn, src_key, dst_key)
    await conn.client.delete_object(Bucket=conn.config.bucket, Key=src_key)
    return True


async def _move_prefix(conn: S3Conn, src_pfx: str, dst_pfx: str) -> bool:
    """Relocate every key under ``src_pfx`` to the matching key under
    ``dst_pfx``.

    A directory is a key prefix plus the empty marker object mkdir
    writes, and listing on the prefix returns both, so one walk moves the
    marker and the whole subtree together.

    Args:
        conn (S3Conn): open connection.
        src_pfx (str): source key prefix, trailing slash included.
        dst_pfx (str): destination key prefix, trailing slash included.

    Returns:
        bool: whether any key was found under the source prefix.
    """
    paginator = conn.client.get_paginator("list_objects_v2")
    moved: list[dict[str, str]] = []
    async for page in paginator.paginate(Bucket=conn.config.bucket,
                                         Prefix=src_pfx):
        for obj in page.get("Contents") or []:
            key = obj["Key"]
            await conn.client.copy_object(
                Bucket=conn.config.bucket,
                CopySource={
                    "Bucket": conn.config.bucket,
                    "Key": key
                },
                Key=f"{dst_pfx}{key[len(src_pfx):]}",
            )
            moved.append({"Key": key})
    if not moved:
        return False
    # Deleted only after every copy landed: a partial move that dropped
    # the source would lose the entries that had not been copied yet.
    failed: list[str] = []
    for start in range(0, len(moved), DELETE_BATCH):
        resp = await conn.client.delete_objects(
            Bucket=conn.config.bucket,
            Delete={"Objects": moved[start:start + DELETE_BATCH]},
        )
        # DeleteObjects reports a refused key in the body of a 200, so a
        # response that raises nothing can still have deleted nothing.
        # Ignoring it would leave the source tree in place beside the
        # copy and call the move a success.
        for err in (resp or {}).get("Errors") or []:
            failed.append(str(err.get("Key", "")))
    if failed:
        # Both trees survive, which is what GNU mv leaves behind when the
        # unlink half fails after the copy half succeeded. PermissionError
        # because a refused delete is a lock or a policy in practice, and
        # because it is in FS_ERRORS: mv reports the operand and keeps
        # going instead of aborting the whole command line.
        raise PermissionError(
            f"S3 refused to delete {len(failed)} source object(s) after "
            f"copying, starting at {failed[0]!r}")
    return True


async def _probe_prefix(conn: S3Conn, pfx: str) -> bool:
    resp = await conn.client.list_objects_v2(Bucket=conn.config.bucket,
                                             Prefix=pfx,
                                             Delimiter="/",
                                             MaxKeys=1)
    return bool(resp.get("CommonPrefixes") or resp.get("Contents"))


DRIVER: ObjectStoreDriver[S3Accessor, S3Conn] = ObjectStoreDriver(
    vfs="s3",
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
    is_not_found=is_not_found,
)
