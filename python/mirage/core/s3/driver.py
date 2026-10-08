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

import logging
from collections.abc import AsyncIterator, Awaitable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, TypeVar

from mirage.accessor.s3 import S3Accessor
from mirage.cache.context import KnownVersions, WriteCondition
from mirage.core.object_store.driver import (
    ChildEntry,
    ConditionLost,
    ObjectMeta,
    ObjectStoreDriver,
    TreeEntry,
)
from mirage.core.s3.client import (
    CONDITION_LOST_CODES,
    _client_kwargs,
    async_session,
    closing_body,
    is_condition_lost,
    is_not_found,
)
from mirage.core.s3.constants import SCOPE_ERROR
from mirage.utils.dates import to_iso_z
from mirage.vfs.s3.config import S3Config

logger = logging.getLogger(__name__)

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
    client = await accessor.cached_client(
        lambda: async_session(accessor.config).client(
            **_client_kwargs(accessor.config)
        )
    )
    yield S3Conn(client=client, config=accessor.config)


async def _list_children(conn: S3Conn, pfx: str) -> AsyncIterator[ChildEntry]:
    paginator = conn.client.get_paginator("list_objects_v2")
    async for page in paginator.paginate(
        Bucket=conn.config.bucket, Prefix=pfx, Delimiter="/"
    ):
        for cp in page.get("CommonPrefixes") or []:
            child = cp["Prefix"].rstrip("/")
            if child:
                yield ChildEntry(key=child, kind="d")
            else:
                yield ChildEntry(key=cp["Prefix"], kind="marker")
        for obj in page.get("Contents") or []:
            relative = obj["Key"][len(pfx) :]
            if relative and "/" not in relative:
                last_mod = obj.get("LastModified")
                yield ChildEntry(
                    key=obj["Key"],
                    kind="f",
                    size=obj.get("Size"),
                    modified=to_iso_z(last_mod) if last_mod else "",
                )
            else:
                yield ChildEntry(key=obj["Key"], kind="marker")


async def _list_tree(conn: S3Conn, pfx: str) -> AsyncIterator[TreeEntry]:
    paginator = conn.client.get_paginator("list_objects_v2")
    async for page in paginator.paginate(
        Bucket=conn.config.bucket, Prefix=pfx
    ):
        for obj in page.get("Contents") or []:
            yield TreeEntry(
                key=obj["Key"],
                size=obj.get("Size", 0),
                modified=to_iso_z(obj["LastModified"])
                if obj.get("LastModified")
                else "",
            )


async def _list_subtree(conn: S3Conn, stem: str) -> AsyncIterator[TreeEntry]:
    # The prefix listing also matches sibling keys sharing the stem as a
    # name prefix ("data-old" under stem "data"), so each key is checked
    # against the exact stem or the slashed subtree.
    base = (stem + "/") if stem else ""
    paginator = conn.client.get_paginator("list_objects_v2")
    async for page in paginator.paginate(
        Bucket=conn.config.bucket, Prefix=stem
    ):
        for obj in page.get("Contents") or []:
            okey = obj["Key"]
            if not (okey == stem or okey.startswith(base)):
                continue
            yield TreeEntry(
                key=okey,
                size=obj.get("Size", 0),
                modified=to_iso_z(obj["LastModified"])
                if obj.get("LastModified")
                else "",
            )


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
        resp = await conn.client.head_object(
            Bucket=conn.config.bucket, Key=key
        )
    except Exception as exc:
        if is_not_found(exc):
            return None
        raise
    etag_raw = _etag_of(resp)
    return ObjectMeta(
        size=resp["ContentLength"],
        modified=to_iso_z(resp["LastModified"]),
        fingerprint=etag_raw or None,
        revision=_version_of(resp),
        extra={"etag": etag_raw},
    )


async def _get(conn: S3Conn, key: str) -> bytes | None:
    got = await _get_versioned(conn, key)
    return got[0] if got is not None else None


async def _put(conn: S3Conn, key: str, data: bytes) -> ObjectMeta | None:
    return await _put_if(conn, key, data, WriteCondition())


def _quoted(token: str) -> str:
    """An ETag as the wire spells it; tokens are stored unquoted.

    Args:
        token (str): the ETag, quoted or not.
    """
    return token if token.startswith('"') else f'"{token}"'


def _condition(cond: WriteCondition) -> dict[str, str]:
    if cond.if_match is not None:
        return {"IfMatch": _quoted(cond.if_match)}
    return {}


T = TypeVar("T")


def _lost_condition(exc: Exception, matched: bool) -> bool:
    """Whether a conditioned request lost its condition.

    A version sent with ``If-Match`` loses on a 412, and on a 404 too: AWS
    answers that way for a key deleted since it was read.

    Args:
        exc (Exception): the error the request raised.
        matched (bool): whether the request carried an ``If-Match``.
    """
    return is_condition_lost(exc) or (matched and is_not_found(exc))


async def _guarded(key: str, call: Awaitable[T], matched: bool = False) -> T:
    try:
        return await call
    except Exception as exc:
        if _lost_condition(exc, matched):
            raise ConditionLost(
                [key], gone=not is_condition_lost(exc)
            ) from exc
        raise


async def _put_if(
    conn: S3Conn, key: str, data: bytes, cond: WriteCondition
) -> ObjectMeta | None:
    # The ETag is read through the same helper _head uses, so the token a
    # write stamps and the token a later stat reports are one spelling.
    # A write carries no type of its own, so the mount's default is the
    # one the store keeps and serves back.
    content_type = conn.config.default_content_type
    resp = await _guarded(
        key,
        conn.client.put_object(
            Bucket=conn.config.bucket,
            Key=key,
            Body=data,
            **({"ContentType": content_type} if content_type else {}),
            **_condition(cond),
        ),
        matched=cond.if_match is not None,
    )
    return ObjectMeta(
        size=len(data),
        fingerprint=_etag_of(resp) or None,
        revision=_version_of(resp),
    )


async def _get_versioned(
    conn: S3Conn, key: str
) -> tuple[bytes, str | None] | None:
    try:
        resp = await conn.client.get_object(Bucket=conn.config.bucket, Key=key)
    except Exception as exc:
        if is_not_found(exc):
            return None
        raise
    async with closing_body(resp["Body"]) as body:
        data: bytes = await body.read()
    return data, _etag_of(resp) or None


async def _copy_if(
    conn: S3Conn, src_key: str, dst_key: str, cond: WriteCondition
) -> bool:
    try:
        await conn.client.copy_object(
            Bucket=conn.config.bucket,
            CopySource={"Bucket": conn.config.bucket, "Key": src_key},
            Key=dst_key,
            **_condition(cond),
        )
    except Exception as exc:
        # A 404 is lost only while the source is still there.
        lost = is_condition_lost(exc)
        if not lost and cond.if_match is not None and is_not_found(exc):
            try:
                lost = await _head(conn, src_key) is not None
            except Exception:
                logger.debug(
                    "source probe failed for %s", src_key, exc_info=True
                )
        if lost:
            gone = not is_condition_lost(exc)
            raise ConditionLost([dst_key], gone=gone) from exc
        raise
    return True


async def _delete_if(conn: S3Conn, key: str, cond: WriteCondition) -> None:
    await _guarded(
        key,
        conn.client.delete_object(
            Bucket=conn.config.bucket, Key=key, **_condition(cond)
        ),
    )


async def _copy_loser(
    conn: S3Conn,
    src_key: str,
    dst_key: str,
    cond: WriteCondition,
    source: str,
) -> ConditionLost:
    """Which end of a refused copy changed: the destination or the source.

    S3 answers 412 for either condition, so the destination is looked up:
    one no longer at the version sent is the end that lost; otherwise the
    source's pin did. Only a refusal pays for the lookup. The end named
    carries the version it lost on, none when it is gone.

    Args:
        conn (S3Conn): the open connection.
        src_key (str): the source key, pinned by ``CopySourceIfMatch``.
        dst_key (str): the destination key.
        cond (WriteCondition): the destination's condition.
        source (str): the source's pin.
    """
    try:
        if cond.if_match is not None:
            meta = await _head(conn, dst_key)
            if meta is None or _quoted(meta.fingerprint or "") != _quoted(
                cond.if_match
            ):
                return _lost_on(dst_key, cond.if_match, gone=meta is None)
        gone = await _head(conn, src_key) is None
        return _lost_on(src_key, source, gone=gone)
    except Exception:
        # Unknown which end changed: name the source; both keep versions.
        logger.debug("copy loser lookup failed for %s", dst_key, exc_info=True)
        return _lost_on(src_key, source)


def _lost_on(
    key: str, version: str, gone: bool = False, landed: bool = False
) -> ConditionLost:
    """A refusal of ``key``, keeping the version it lost on unless gone.

    Args:
        key (str): the key whose condition lost.
        version (str): the version it was measured on.
        gone (bool): the key no longer exists.
        landed (bool): the move's copy landed before the loss.
    """
    return ConditionLost(
        [key],
        landed=landed,
        gone=gone,
        versions={} if gone else {key: _quoted(version)},
    )


async def _move_file_if(
    conn: S3Conn,
    src_key: str,
    dst_key: str,
    cond: WriteCondition,
    source: str | None,
) -> bool:
    # Pin the source to the agent's version, else to this lookup's.
    if source is None:
        meta = await _head(conn, src_key)
        if meta is None:
            return False
        source = meta.fingerprint or ""
    source = _quoted(source)
    try:
        await conn.client.copy_object(
            Bucket=conn.config.bucket,
            CopySource={"Bucket": conn.config.bucket, "Key": src_key},
            Key=dst_key,
            CopySourceIfMatch=source,
            **_condition(cond),
        )
    except Exception as exc:
        if not _lost_condition(exc, matched=True):
            raise
        raise await _copy_loser(conn, src_key, dst_key, cond, source) from exc
    try:
        await _guarded(
            src_key,
            conn.client.delete_object(
                Bucket=conn.config.bucket, Key=src_key, IfMatch=source
            ),
            matched=True,
        )
    except ConditionLost as exc:
        raise _lost_on(src_key, source, gone=exc.gone, landed=True) from exc
    return True


async def _known_pages(
    conn: S3Conn, pfx: str, known: KnownVersions
) -> AsyncIterator[list[tuple[str, str]]]:
    """Each listing page under ``pfx``, every key with its version.

    The version the agent read where there is one, else the listing's,
    one page at a time.

    Args:
        conn (S3Conn): the open connection.
        pfx (str): the key prefix walked.
        known (KnownVersions): the mount's versions for the listed keys.
    """
    paginator = conn.client.get_paginator("list_objects_v2")
    async for page in paginator.paginate(
        Bucket=conn.config.bucket, Prefix=pfx
    ):
        listed = [
            (obj["Key"], _quoted(str(obj.get("ETag") or "")))
            for obj in page.get("Contents") or []
        ]
        if not listed:
            continue
        versions = await known([key for key, _ in listed])
        yield [
            (key, _quoted(versions[key]) if key in versions else token)
            for key, token in listed
        ]


def _refused(failed: list[str]) -> PermissionError:
    """The error for keys a DeleteObjects refused in the body of its 200.

    Args:
        failed (list[str]): the refused keys, in the order reported.
    """
    return PermissionError(
        f"S3 refused to delete {len(failed)} object(s), "
        f"starting at {failed[0]!r}"
    )


async def _delete_batch(
    conn: S3Conn, listed: list[tuple[str, str]]
) -> tuple[list[tuple[str, str]], list[str]]:
    """Delete each listed key only while it is the version listed.

    Args:
        conn (S3Conn): the open connection.
        listed (list[tuple[str, str]]): each key with the ETag it must
            still carry.

    Returns:
        tuple[list[tuple[str, str]], list[str]]: the keys a newer write
        changed, which were kept, each with the ETag it was measured on,
        and the keys the store refused for another reason.
    """
    lost: list[tuple[str, str]] = []
    failed: list[str] = []
    for start in range(0, len(listed), DELETE_BATCH):
        batch = listed[start : start + DELETE_BATCH]
        sent = dict(batch)
        resp = await conn.client.delete_objects(
            Bucket=conn.config.bucket,
            Delete={"Objects": [{"Key": k, "ETag": e} for k, e in batch]},
        )
        # A refusal comes back per key in the body of a 200.
        for err in (resp or {}).get("Errors") or []:
            key = str(err.get("Key", ""))
            if err.get("Code") in CONDITION_LOST_CODES:
                lost.append((key, sent.get(key, "")))
            else:
                failed.append(key)
    return lost, failed


def _raise_kept(lost: list[tuple[str, str]], failed: list[str]) -> None:
    """Raise for the keys a prefix op kept.

    Lost keys come first, so the caller drops their cached copies and
    keeps the versions they were measured on; keys the store refused for
    another reason come next.

    Args:
        lost (list[tuple[str, str]]): keys a newer write changed, each
            with the version it was measured on.
        failed (list[str]): keys the store refused for another reason.

    Raises:
        ConditionLost: some keys were lost.
        PermissionError: no key was lost and some were refused.
    """
    if lost:
        raise ConditionLost([key for key, _ in lost], versions=dict(lost))
    if failed:
        raise _refused(failed)


async def _delete_prefix_if(
    conn: S3Conn, pfx: str, known: KnownVersions
) -> None:
    lost: list[tuple[str, str]] = []
    failed: list[str] = []
    async for listed in _known_pages(conn, pfx, known):
        page_lost, page_failed = await _delete_batch(conn, listed)
        lost += page_lost
        failed += page_failed
    _raise_kept(lost, failed)


async def _move_prefix_if(
    conn: S3Conn, src_pfx: str, dst_pfx: str, known: KnownVersions
) -> bool:
    found = False
    lost: list[tuple[str, str]] = []
    moved: list[tuple[str, str]] = []
    async for listed in _known_pages(conn, src_pfx, known):
        found = True
        for key, token in listed:
            try:
                await conn.client.copy_object(
                    Bucket=conn.config.bucket,
                    CopySource={"Bucket": conn.config.bucket, "Key": key},
                    Key=f"{dst_pfx}{key[len(src_pfx) :]}",
                    CopySourceIfMatch=token,
                )
            except Exception as exc:
                if not _lost_condition(exc, matched=True):
                    raise
                # A source gone (404) keeps no version: nothing newer to guard.
                lost.append((key, token if is_condition_lost(exc) else ""))
                continue
            moved.append((key, token))
    delete_lost, failed = await _delete_batch(conn, moved)
    _raise_kept(lost + delete_lost, failed)
    return found


async def _delete_file(conn: S3Conn, key: str) -> None:
    await conn.client.delete_object(Bucket=conn.config.bucket, Key=key)


async def _delete_prefix(conn: S3Conn, pfx: str) -> None:
    paginator = conn.client.get_paginator("list_objects_v2")
    async for page in paginator.paginate(
        Bucket=conn.config.bucket, Prefix=pfx
    ):
        keys = [{"Key": obj["Key"]} for obj in page.get("Contents") or []]
        if keys:
            resp = await conn.client.delete_objects(
                Bucket=conn.config.bucket, Delete={"Objects": keys}
            )
            # A refused key comes back in the body of a 200.
            failed = [
                str(err.get("Key", ""))
                for err in (resp or {}).get("Errors") or []
            ]
            if failed:
                raise _refused(failed)


async def _copy_file(conn: S3Conn, src_key: str, dst_key: str) -> bool:
    await conn.client.copy_object(
        Bucket=conn.config.bucket,
        CopySource={"Bucket": conn.config.bucket, "Key": src_key},
        Key=dst_key,
    )
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
    async for page in paginator.paginate(
        Bucket=conn.config.bucket, Prefix=src_pfx
    ):
        for obj in page.get("Contents") or []:
            key = obj["Key"]
            await conn.client.copy_object(
                Bucket=conn.config.bucket,
                CopySource={"Bucket": conn.config.bucket, "Key": key},
                Key=f"{dst_pfx}{key[len(src_pfx) :]}",
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
            Delete={"Objects": moved[start : start + DELETE_BATCH]},
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
            f"copying, starting at {failed[0]!r}"
        )
    return True


async def _probe_prefix(conn: S3Conn, pfx: str) -> bool:
    resp = await conn.client.list_objects_v2(
        Bucket=conn.config.bucket, Prefix=pfx, Delimiter="/", MaxKeys=1
    )
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
    put_if=_put_if,
    get_versioned=_get_versioned,
    copy_if=_copy_if,
    delete_if=_delete_if,
    move_file_if=_move_file_if,
    move_prefix_if=_move_prefix_if,
    delete_prefix_if=_delete_prefix_if,
)
