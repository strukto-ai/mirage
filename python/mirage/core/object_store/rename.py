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

from mirage.cache.context import (
    drop_cached,
    evict_after,
    invalidate_after_move,
    invalidate_ancestors,
    known_versions,
    stale,
    write_condition,
)
from mirage.core.object_store.driver import (
    A,
    C,
    ConditionLost,
    ExistsFn,
    ObjectStoreDriver,
    PairFn,
    keep_lost,
)
from mirage.errors.fs import enoent
from mirage.observe.context import record, start_op
from mirage.types import PathSpec
from mirage.utils import key_prefix as kp


def make_rename(
    driver: ObjectStoreDriver[A, C], exists: ExistsFn[A]
) -> PairFn[A]:
    """Build file-or-prefix relocation over one driver.

    A single object moves with the driver's native file move. A
    directory owns no object of its own, so it moves as a prefix walk; a
    source that is neither is ENOENT rather than the raw store error.

    Args:
        driver (ObjectStoreDriver): the store's native surface; must
            carry a native move — a store without one leaves rename
            unwired, which the dispatcher surfaces as ENOTSUP.
        exists (ExistsFn): the backend's existence probe, for the
            same-key guard.
    """
    move_file = driver.move_file
    move_prefix = driver.move_prefix
    if move_file is None or move_prefix is None:
        raise ValueError(
            f"{driver.vfs} driver has no native move; leave rename "
            "unwired instead of building it"
        )

    async def rename(
        accessor: A, src_spec: PathSpec, dst_spec: PathSpec
    ) -> None:
        src = src_spec.mount_path
        dst = dst_spec.mount_path
        kpfx = driver.key_prefix_of(accessor)
        src_key = kp.apply(kpfx, src)
        if src_key == kp.apply(kpfx, dst):
            # POSIX rename(2): the same existing file succeeds and
            # performs no other action. Reaching the move below would
            # instead delete the object on any store that accepts the
            # self-copy, and error on the ones that reject it (#150).
            if not await exists(accessor, src_spec):
                raise enoent(src_spec)
            return
        timer = start_op()
        # Which of the two paths ran, because only the prefix walk moves
        # a subtree and capture retracts on the op name. A raise from
        # move_file leaves this "rename": the walk never ran, so nothing
        # under the prefix can have moved.
        op = "rename"
        # A move is a copy then a delete, so both carry a condition.
        cond = await write_condition(dst_spec, "copy")
        source: str | None = None
        if cond is not None:
            src_cond = await write_condition(src_spec, "delete")
            source = src_cond.if_match if src_cond is not None else None

        async def move(conn: C) -> bool:
            nonlocal op
            if cond is not None:
                move_file_if = driver.move_file_if
                move_prefix_if = driver.move_prefix_if
                assert move_file_if is not None and move_prefix_if is not None
                if await move_file_if(
                    conn, src_key, kp.apply(kpfx, dst), cond, source
                ):
                    return True
                op = "rename_prefix"
                return await move_prefix_if(
                    conn,
                    kp.apply_dir(kpfx, src),
                    kp.apply_dir(kpfx, dst),
                    known_versions(src_spec, kpfx),
                )
            if await move_file(conn, src_key, kp.apply(kpfx, dst)):
                return True
            # A directory owns no object of its own, so a clean False
            # here is the ordinary way into the prefix walk, not an
            # answer about it.
            op = "rename_prefix"
            return await move_prefix(
                conn, kp.apply_dir(kpfx, src), kp.apply_dir(kpfx, dst)
            )

        async def settle(moved: bool | None) -> None:
            # None when the store raised: move_prefix is a paginated walk
            # that can fail having already moved keys, so only a clean
            # False, where nothing moved at all, is skipped.
            if moved is False:
                return
            # Two records for one op, because a move invalidates the
            # token of both paths: src's object left, dst's was replaced
            # by it. Order is free -- both are pure retractions and
            # deletions commute -- but it stops being free if either
            # carries a token.
            record(op, src_spec.virtual, driver.vfs, 0, timer)
            record(op, dst_spec.virtual, driver.vfs, 0, timer)
            # The eviction rides with the records, as in unlink. Only a
            # clean move_file names a file, which has nothing beneath it;
            # move_prefix relocates every key under src, and a raise
            # leaves the kind unknown, so those evict both subtrees.
            folder = op != "rename" or moved is None
            await invalidate_after_move(dst_spec, folder)
            await invalidate_after_move(src_spec, folder)
            # The move can create the destination's missing ancestors and
            # erase the source's prefix-only ones in the same call.
            await invalidate_ancestors(dst_spec)
            await invalidate_ancestors(src_spec)

        async with driver.connect(accessor) as conn:
            try:
                moved = await evict_after(move(conn), settle)
            except ConditionLost as exc:
                key = exc.keys[0]
                if key == kp.apply(kpfx, dst):
                    lost = dst_spec
                    sent = cond.if_match if cond is not None else None
                elif key == src_key:
                    lost, sent = src_spec, exc.versions.get(key, source)
                else:
                    lost = kp.key_path(src_spec, kpfx, key)
                    sent = exc.versions.get(key)
                await keep_lost(src_spec, kpfx, exc, key)
                # A landed copy left the destination unsure; a refused one
                # left both ends as they were, and the untouched one keeps
                # the version the agent read.
                if exc.landed:
                    await drop_cached(dst_spec)
                elif lost is dst_spec:
                    if source:
                        await drop_cached(src_spec, source)
                elif cond is not None and cond.if_match:
                    await drop_cached(dst_spec, cond.if_match)
                raise await stale(
                    lost, landed=exc.landed, gone=exc.gone, version=sent
                ) from exc
        if not moved:
            raise enoent(src_spec.virtual)

    return rename
