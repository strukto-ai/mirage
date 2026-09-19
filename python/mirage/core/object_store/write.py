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

from mirage.cache.context import invalidate_after_write, invalidate_ancestors
from mirage.core.object_store.driver import (A, C, MkdirFn, ObjectMeta,
                                             ObjectStoreDriver, PathFn,
                                             TruncateFn, WriteFn)
from mirage.observe.context import record, start_op
from mirage.types import PathSpec
from mirage.utils import key_prefix as kp
from mirage.utils.errors import enoent


async def _put(driver: ObjectStoreDriver[A, C], conn: C, key: str, data: bytes,
               path_spec: PathSpec) -> ObjectMeta | None:
    """Put one object, translating a missing container to ENOENT.

    The driver primitives speak keys, so a store error for a missing
    repository or bucket names the backend key, and only the factory
    holds the PathSpec the message has to carry.

    Callers stamp ``meta.fingerprint`` on the op record and deliberately
    leave ``meta.revision`` off it. Nothing reads a write record's
    revision today -- ``capture_fingerprints`` still filters to reads --
    but once it does, an entry carrying one is pinned by
    ``install_fingerprints`` instead of drift-checked, and on a versioned
    store that pin would name the revision preceding this write.

    Args:
        driver (ObjectStoreDriver): the store's native surface.
        conn (C): the open store connection.
        key (str): the prefix-applied object key.
        data (bytes): the object body.
        path_spec (PathSpec): the operand, for the error's virtual path.

    Returns:
        ObjectMeta | None: what the store's write response said about the
        object, None when it reports nothing.
    """
    try:
        return await driver.put(conn, key, data)
    except Exception as exc:
        if driver.is_not_found(exc):
            raise enoent(path_spec) from exc
        raise


def make_write_bytes(driver: ObjectStoreDriver[A, C]) -> WriteFn[A]:
    """Build the whole-object write over one driver.

    Args:
        driver (ObjectStoreDriver): the store's native surface.
    """

    async def write_bytes(accessor: A, path_spec: PathSpec,
                          data: bytes) -> None:
        path = path_spec.mount_path
        key = kp.apply(driver.key_prefix_of(accessor), path)
        timer = start_op()
        async with driver.connect(accessor) as conn:
            meta = await _put(driver, conn, key, data, path_spec)
        record("write",
               path,
               driver.vfs,
               len(data),
               timer,
               fingerprint=meta.fingerprint if meta else None)
        await invalidate_after_write(path_spec)
        # A put materializes every missing level of the key at once, so
        # the listings above the immediate parent gained entries too.
        await invalidate_ancestors(path_spec)

    return write_bytes


def make_create(driver: ObjectStoreDriver[A, C]) -> PathFn[A]:
    """Build the empty-object create over one driver.

    Args:
        driver (ObjectStoreDriver): the store's native surface.
    """

    async def create(accessor: A, path_spec: PathSpec) -> None:
        path = path_spec.mount_path
        key = kp.apply(driver.key_prefix_of(accessor), path)
        timer = start_op()
        async with driver.connect(accessor) as conn:
            meta = await _put(driver, conn, key, b"", path_spec)
        record("create",
               path,
               driver.vfs,
               0,
               timer,
               fingerprint=meta.fingerprint if meta else None)
        await invalidate_after_write(path_spec)
        # An empty put materializes missing parents exactly like write.
        await invalidate_ancestors(path_spec)

    return create


def make_truncate(driver: ObjectStoreDriver[A, C]) -> TruncateFn[A]:
    """Build read-slice-pad-rewrite truncation over one driver.

    Args:
        driver (ObjectStoreDriver): the store's native surface.
    """

    async def truncate(accessor: A, path_spec: PathSpec, length: int) -> None:
        path = path_spec.mount_path
        key = kp.apply(driver.key_prefix_of(accessor), path)
        timer = start_op()
        async with driver.connect(accessor) as conn:
            data = await driver.get(conn, key)
            if data is None:
                data = b""
            result = data[:length].ljust(length, b"\0")
            meta = await _put(driver, conn, key, result, path_spec)
        record("truncate",
               path,
               driver.vfs,
               0,
               timer,
               fingerprint=meta.fingerprint if meta else None)
        await invalidate_after_write(path_spec)
        # Truncating a missing key creates it, parents included.
        await invalidate_ancestors(path_spec)

    return truncate


def make_mkdir(driver: ObjectStoreDriver[A, C]) -> MkdirFn[A]:
    """Build the marker-object mkdir over one driver.

    Args:
        driver (ObjectStoreDriver): the store's native surface.
    """

    async def mkdir(accessor: A,
                    path_spec: PathSpec,
                    parents: bool = False) -> None:
        if not driver.markers_supported:
            # The store refuses the marker client-side (hf: create_dir is
            # unsupported and a slash-terminated write is IsADirectory),
            # so a directory exists only while it holds a key and mkdir
            # has nothing to write: `mkdir x` then `rmdir x` is ENOENT
            # here but fine on a marker store.
            return
        # Object stores have no real directories; parents is implicit. A
        # zero-byte marker keyed at the prefix makes the empty directory
        # visible.
        path = path_spec.mount_path
        pfx = kp.apply_dir(driver.key_prefix_of(accessor), path)
        if pfx:
            async with driver.connect(accessor) as conn:
                await driver.put(conn, pfx, b"")
            await invalidate_after_write(path_spec)
            if parents:
                await invalidate_ancestors(path_spec)

    return mkdir
