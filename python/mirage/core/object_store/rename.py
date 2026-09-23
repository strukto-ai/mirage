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

from mirage.cache.context import invalidate_ancestors, invalidate_subtree
from mirage.core.object_store.driver import (A, C, ExistsFn, ObjectStoreDriver,
                                             PairFn)
from mirage.observe.context import record, start_op
from mirage.types import PathSpec
from mirage.utils import key_prefix as kp
from mirage.utils.errors import enoent


def make_rename(driver: ObjectStoreDriver[A, C],
                exists: ExistsFn[A]) -> PairFn[A]:
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
            "unwired instead of building it")

    async def rename(accessor: A, src_spec: PathSpec,
                     dst_spec: PathSpec) -> None:
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
        # None until the store answers: False means it told us cleanly
        # that nothing moved, and only a clean "nothing" is safe to skip.
        moved: bool | None = None
        # Which of the two paths ran, because only the prefix walk moves
        # a subtree and capture retracts on the op name. A raise from
        # move_file leaves this "rename": the walk below never ran, so
        # nothing under the prefix can have moved.
        op = "rename"
        async with driver.connect(accessor) as conn:
            try:
                moved = await move_file(conn, src_key, kp.apply(kpfx, dst))
                if not moved:
                    # A directory owns no object of its own, so a clean
                    # False here is the ordinary way into the prefix
                    # walk, not an answer about it. Back to unanswered
                    # before asking, or a walk that raises having
                    # already moved keys reads as "nothing moved" and
                    # skips the record it is in `finally` for.
                    moved = None
                    op = "rename_prefix"
                    moved = await move_prefix(conn, kp.apply_dir(kpfx, src),
                                              kp.apply_dir(kpfx, dst))
            finally:
                if moved is not False:
                    # Two records for one op, because a move invalidates
                    # the token of both paths: src's object left, dst's
                    # was replaced by it. In `finally` because
                    # move_prefix is a paginated walk that can fail
                    # having already moved keys; skipped only on a clean
                    # False, where nothing moved at all. Order is free --
                    # both are pure retractions and deletions commute --
                    # but it stops being free if either carries a token.
                    record(op, src, driver.vfs, 0, timer)
                    record(op, dst, driver.vfs, 0, timer)
                    # The eviction rides with the records, on the same
                    # condition, as in unlink. Subtrees, not single
                    # paths: move_prefix relocates every key under src,
                    # so each listing and body cached below the old name
                    # names something that is no longer there, and each
                    # one below the new name predates the move.
                    await invalidate_subtree(dst_spec)
                    await invalidate_subtree(src_spec)
                    # The move can create the destination's missing
                    # ancestors and erase the source's prefix-only ones
                    # in the same call.
                    await invalidate_ancestors(dst_spec)
                    await invalidate_ancestors(src_spec)
        if not moved:
            raise enoent(src_spec.virtual)

    return rename
