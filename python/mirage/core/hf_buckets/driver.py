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

from opendal import AsyncOperator
from opendal.exceptions import NotFound
from opendal.types import EntryMode

from mirage.accessor._hf import _HfAccessor
from mirage.core.hf_buckets.constants import SCOPE_ERROR
from mirage.core.object_store.driver import (ChildEntry, ObjectMeta,
                                             ObjectStoreDriver, TreeEntry)


def _key_prefix_of(accessor: _HfAccessor) -> str:
    # key_prefix is applied as the operator's root (see _HfAccessor), so
    # every key the driver sees is already prefix-relative.
    return ""


@asynccontextmanager
async def _connect(accessor: _HfAccessor) -> AsyncIterator[AsyncOperator]:
    # One fresh AsyncOperator per op invocation, held for the op's whole
    # body (the Hub client is stateless; the accessor builds it cheaply).
    yield accessor.operator()


def _dir_path(pfx: str) -> str:
    return pfx if pfx else "/"


async def _list_children(op: AsyncOperator,
                         pfx: str) -> AsyncIterator[ChildEntry]:
    path = _dir_path(pfx)
    try:
        async for entry in await op.list(path):
            rel = entry.path
            if not rel:
                continue
            if rel == path:
                # The lister reported the directory itself; it proves the
                # prefix holds something but names no child.
                yield ChildEntry(key=rel, kind="marker")
                continue
            if rel.endswith("/"):
                yield ChildEntry(key=rel.rstrip("/"), kind="d")
                continue
            meta = entry.metadata
            size = meta.content_length if meta is not None else None
            if size is None:
                # The Hub tree API carries a size for every file (for LFS
                # files it is the object size, not the pointer's); when
                # the lister omits the metadata, one stat per affected
                # file fills the gap so the index never caches an unknown
                # size.
                md = await op.stat(rel)
                size = md.content_length
            yield ChildEntry(key=rel, kind="f", size=size)
    except NotFound:
        # The Hub answers a missing subpath with 200 and [] more often
        # than with an error; either way an empty yield is what lets the
        # kit's missing-directory classification run.
        return


async def _list_tree(op: AsyncOperator, pfx: str) -> AsyncIterator[TreeEntry]:
    path = _dir_path(pfx)
    try:
        async for entry in await op.list(path, recursive=True):
            rel = entry.path
            if not rel:
                continue
            if rel.rstrip("/") == path.rstrip("/"):
                # The scanned directory itself, translated to the key the
                # kit compares against the prefix.
                yield TreeEntry(key=pfx)
                continue
            meta = entry.metadata
            is_dir = rel.endswith("/") or (meta is not None
                                           and meta.mode == EntryMode.Dir)
            if is_dir:
                yield TreeEntry(key=rel.rstrip("/") + "/")
                continue
            size = meta.content_length if meta is not None else None
            modified = (meta.last_modified.isoformat()
                        if meta is not None and meta.last_modified else "")
            yield TreeEntry(key=rel, size=size, modified=modified)
    except NotFound:
        return


async def _list_subtree(op: AsyncOperator,
                        stem: str) -> AsyncIterator[TreeEntry]:
    if stem:
        md = None
        try:
            md = await op.stat(stem)
        except NotFound:
            md = None
        if md is not None and md.mode != EntryMode.Dir:
            # A repo cannot hold a file and a directory of the same name,
            # so a stem that is a file has nothing under it.
            modified = md.last_modified.isoformat() if md.last_modified else ""
            yield TreeEntry(key=stem,
                            size=md.content_length,
                            modified=modified)
            return
    base = stem + "/" if stem else "/"
    try:
        async for entry in await op.list(base, recursive=True):
            rel = entry.path
            if not rel or rel.endswith("/"):
                continue
            meta = entry.metadata
            size = meta.content_length if meta is not None else None
            modified = (meta.last_modified.isoformat()
                        if meta is not None and meta.last_modified else "")
            yield TreeEntry(key=rel, size=size, modified=modified)
    except NotFound:
        return


async def _head(op: AsyncOperator, key: str) -> ObjectMeta | None:
    try:
        md = await op.stat(key)
    except NotFound:
        return None
    if md.mode == EntryMode.Dir:
        return None
    modified = md.last_modified.isoformat() if md.last_modified else None
    etag = md.etag
    return ObjectMeta(size=md.content_length,
                      modified=modified,
                      fingerprint=etag,
                      extra={"etag": etag} if etag else {})


async def _get(op: AsyncOperator, key: str) -> bytes | None:
    try:
        return bytes(await op.read(key))
    except NotFound:
        return None


async def _put(op: AsyncOperator, key: str, data: bytes) -> ObjectMeta | None:
    # A missing repo or revision answers NotFound; it propagates so the
    # write factory can name the path the user typed, not this key.
    # No token: the python opendal binding's write returns nothing where
    # node's answers Metadata, and node's is discarded to match, so an hf
    # write stamps the same absence in both languages. Closing it needs a
    # stat per write.
    await op.write(key, data)
    return None


async def _delete_file(op: AsyncOperator, key: str) -> None:
    try:
        await op.delete(key)
    except NotFound:
        # Deleting a missing key is silent, per the driver contract.
        return


async def _delete_prefix(op: AsyncOperator, pfx: str) -> None:
    path = _dir_path(pfx)
    try:
        keys = [
            entry.path async for entry in await op.list(path, recursive=True)
            if not entry.path.endswith("/")
        ]
    except NotFound:
        return
    # The Hub has no batch delete; one request per key.
    for key in keys:
        await op.delete(key)


async def _probe_prefix(op: AsyncOperator, pfx: str) -> bool:
    try:
        async for _ in await op.list(_dir_path(pfx)):
            return True
    except NotFound:
        return False
    return False


def _is_not_found(exc: Exception) -> bool:
    return isinstance(exc, NotFound)


DRIVER: ObjectStoreDriver[_HfAccessor, AsyncOperator] = ObjectStoreDriver(
    vfs="hf",
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
    probe_prefix=_probe_prefix,
    is_not_found=_is_not_found,
    markers_supported=False,
)
