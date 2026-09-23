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

from mirage.cache.context import (invalidate_after_unlink,
                                  invalidate_ancestors, invalidate_subtree)
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.object_store.driver import (A, C, ObjectStoreDriver, PathFn,
                                             RmdirFn)
from mirage.observe.context import record, start_op
from mirage.types import PathSpec
from mirage.utils import key_prefix as kp
from mirage.utils.errors import enoent, enotempty


def make_unlink(driver: ObjectStoreDriver[A, C]) -> PathFn[A]:
    """Build single-key deletion over one driver.

    Args:
        driver (ObjectStoreDriver): the store's native surface.
    """

    async def unlink(accessor: A, path_spec: PathSpec) -> None:
        path = path_spec.mount_path
        key = kp.apply(driver.key_prefix_of(accessor), path)
        timer = start_op()
        async with driver.connect(accessor) as conn:
            try:
                await driver.delete_file(conn, key)
            finally:
                # In `finally`, not on success: a delete that raises
                # part-way has already removed keys, and a pin that
                # outlives the object it names fails the next snapshot
                # load. The connect is outside, because a connection that
                # never opened removed nothing.
                record("unlink", path, driver.vfs, 0, timer)
                # The eviction rides with the record: a retracted pin and
                # a cached body for the same path must not both survive,
                # or a restored snapshot serves the body with nothing
                # left to check it. Over-dropping costs one refetch.
                await invalidate_after_unlink(path_spec)
                # Deleting the last key under a prefix makes every
                # ancestor that existed only as that prefix disappear, so
                # their cached listings are stale symmetrically to the
                # write case.
                await invalidate_ancestors(path_spec)

    return unlink


def make_remove_prefix(driver: ObjectStoreDriver[A, C]) -> PathFn[A]:
    """Build recursive prefix deletion over one driver.

    Serves both the ``rm_r`` and ``rmdir`` slots: on a keyed store an
    empty directory is its marker object, so removing it and removing a
    subtree are the same prefix delete.

    Args:
        driver (ObjectStoreDriver): the store's native surface.
    """

    async def remove_prefix(accessor: A, path_spec: PathSpec) -> None:
        path = path_spec.mount_path
        pfx = kp.apply_dir(driver.key_prefix_of(accessor), path)
        timer = start_op()
        async with driver.connect(accessor) as conn:
            try:
                await driver.delete_prefix(conn, pfx)
            finally:
                # A prefix delete is a paginated walk, so a failure
                # mid-walk has already removed keys. The eviction rides
                # with the record, as in unlink.
                record("rm_r", path, driver.vfs, 0, timer)
                # Not invalidate_after_unlink: a prefix delete takes
                # every key below with it, and each of those listings
                # and bodies was cached under its own key, so nothing
                # above them evicts one.
                await invalidate_subtree(path_spec)
                # Same rationale as unlink: ancestors that existed only
                # as this prefix are gone now.
                await invalidate_ancestors(path_spec)

    return remove_prefix


def make_rmdir(driver: ObjectStoreDriver[A, C]) -> RmdirFn[A]:
    """Build POSIX ``rmdir`` over one driver: refuse a non-empty prefix.

    Not ``make_remove_prefix``. On a keyed store an empty directory is
    its zero-byte marker object, so a prefix delete removes an empty
    directory correctly and a *non-empty* one recursively, which is
    ``rm -r``, not ``rmdir``. Sharing one function between the two slots
    made ``rmdir`` destroy a whole subtree for every caller that does
    not pre-check emptiness itself, and the command builders are the
    only callers that do: FUSE, ``ws.vfs`` and the sandbox runtimes all
    reach the op directly.

    The listing is the same one ``readdir`` reads, so the two agree on
    what a child is: a ``marker`` entry is the prefix's own marker (or a
    key the delimiter listing could not classify) and proves only that
    the directory exists, while any ``f`` or ``d`` entry is a child and
    makes this ENOTEMPTY. The walk stops at the first child rather than
    listing the whole directory to answer a yes/no question.

    A prefix holding no key at all -- not even the marker -- is a
    directory the store does not have, and rmdir(2) reports ENOENT for
    it. ``make_remove_prefix`` stays silent there on purpose, because
    ``rm -r`` owns that refusal through its own ``-f`` handling.

    Args:
        driver (ObjectStoreDriver): the store's native surface.
    """

    async def rmdir(accessor: A,
                    path_spec: PathSpec,
                    index: IndexCacheStore = NULL_INDEX) -> None:
        path = path_spec.mount_path
        pfx = kp.apply_dir(driver.key_prefix_of(accessor), path)
        is_root = not path.strip("/")
        saw_key = False
        has_child = False
        deleted = False
        timer = start_op()
        async with driver.connect(accessor) as conn:
            try:
                async for child in driver.list_children(conn, pfx):
                    saw_key = True
                    if child.kind != "marker":
                        has_child = True
                        break
                if not has_child and saw_key:
                    # The marker only, never the prefix. Between the
                    # listing above and this delete another writer may
                    # have created a child, and a prefix delete would take
                    # it down too -- the subtree loss this function exists
                    # to stop, in a smaller window. Deleting the one key
                    # that spells "empty directory" cannot reach a child
                    # no matter what arrived after the probe. A root
                    # holding no key has no marker to delete and falls
                    # through as the no-op the prefix delete already was.
                    await driver.delete_file(conn, pfx)
                    deleted = True
            finally:
                # Gated on the delete having run, not on "did not raise":
                # the keyless root above deletes nothing and raises
                # nothing, and a listing that fails after its first
                # marker reaches here having deleted nothing either.
                # Recording in those cases would retract a pin for an
                # object no one touched. A delete that raises is the one
                # case `unlink` treats the other way; here it is
                # immaterial, because what rmdir removes is the "d/"
                # marker and a pin can only ever name the "d" object
                # beside it.
                if deleted:
                    record("rmdir", path, driver.vfs, 0, timer)
        if has_child:
            raise enotempty(path_spec)
        if not saw_key and not is_root:
            raise enoent(path_spec)
        await invalidate_after_unlink(path_spec)
        await invalidate_ancestors(path_spec)

    return rmdir
