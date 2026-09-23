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
from mirage.core.object_store.driver import (A, C, ExistsFn, ObjectStoreDriver,
                                             PairFn)
from mirage.observe.context import record, start_op
from mirage.types import PathSpec
from mirage.utils import key_prefix as kp
from mirage.utils.errors import enoent


def make_copy(driver: ObjectStoreDriver[A, C],
              exists: ExistsFn[A]) -> PairFn[A]:
    """Build single-object copy over one driver.

    Args:
        driver (ObjectStoreDriver): the store's native surface; must
            carry a native copy — a store without one leaves copy
            unwired, which the dispatcher surfaces as ENOTSUP.
        exists (ExistsFn): the backend's existence probe, for the
            same-key guard.
    """
    copy_file = driver.copy_file
    if copy_file is None:
        raise ValueError(f"{driver.vfs} driver has no native copy; leave copy "
                         "unwired instead of building it")

    async def copy(accessor: A, src_spec: PathSpec,
                   dst_spec: PathSpec) -> None:
        src = src_spec.mount_path
        dst = dst_spec.mount_path
        kpfx = driver.key_prefix_of(accessor)
        src_key = kp.apply(kpfx, src)
        dst_key = kp.apply(kpfx, dst)
        if src_key == dst_key:
            # Copying an object onto its own key is a no-op we must not
            # send: AWS and MinIO reject it, and on a versioned store it
            # would only stack an identical revision. A missing source
            # still has to fail (#150).
            if not await exists(accessor, src_spec):
                raise enoent(src_spec)
            return
        timer = start_op()
        # None until the store answers: False means it told us cleanly
        # that nothing was copied, and only a clean "nothing" is safe to
        # skip -- a raise may have left a partial object behind.
        copied: bool | None = None
        async with driver.connect(accessor) as conn:
            try:
                copied = await copy_file(conn, src_key, dst_key)
            finally:
                if copied is not False:
                    # The destination, not the source: a copy replaces
                    # dst's bytes and leaves src untouched, so only dst's
                    # token stops describing its object. (dropbox records
                    # a copy against src; that is inert there only
                    # because dropbox emits no read record at all, so no
                    # dropbox path is ever pinned.)
                    record("copy", dst, driver.vfs, 0, timer)
                    # The eviction rides with the record, on the same
                    # condition, as in unlink.
                    await invalidate_after_write(dst_spec)
                    # The copy can materialize the destination's missing
                    # ancestors.
                    await invalidate_ancestors(dst_spec)
        if not copied:
            raise enoent(src_spec.virtual)

    return copy
