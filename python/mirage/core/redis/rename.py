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

from mirage.accessor.redis import RedisAccessor
from mirage.cache.context import invalidate_subtree
from mirage.core.redis.dest import check_dest_parents
from mirage.core.timeutil import now_iso
from mirage.types import PathSpec
from mirage.utils.path import norm
from mirage.vfs.redis.store import RedisStore


async def _move_subtree(store: RedisStore, s: str, d: str) -> None:
    """Re-key every descendant of a renamed directory.

    A synthetic-directory store keeps subdirectories as members of their
    own set, so moving only the files leaves those behind. The phantom
    tree the orphans imply makes the old name reappear in its parent's
    listing and then stat as missing -- the same shape
    ``check_dest_parents`` refuses on the way in.

    Args:
        store (RedisStore): the backing store.
        s (str): normalized source key.
        d (str): normalized destination key.
    """
    prefix = s.rstrip("/") + "/"
    new_prefix = d.rstrip("/") + "/"
    for key in sorted(await store.list_dirs()):
        if key.startswith(prefix):
            new_key = new_prefix + key[len(prefix):]
            mod = await store.get_modified(key)
            attrs = await store.get_attrs(key)
            await store.remove_dir(key)
            await store.del_modified(key)
            await store.del_attrs(key)
            await store.add_dir(new_key)
            if mod:
                await store.set_modified(new_key, mod)
            if attrs:
                await store.set_attrs(new_key, attrs)
    for key in await store.list_files():
        if key.startswith(prefix):
            new_key = new_prefix + key[len(prefix):]
            data = await store.get_file(key) or b""
            mod = await store.get_modified(key)
            attrs = await store.get_attrs(key)
            await store.del_file(key)
            await store.del_modified(key)
            await store.del_attrs(key)
            await store.set_file(new_key, data)
            if mod:
                await store.set_modified(new_key, mod)
            if attrs:
                await store.set_attrs(new_key, attrs)


async def rename(
    accessor: RedisAccessor,
    src_spec: PathSpec,
    dst_spec: PathSpec,
) -> None:
    src = src_spec.mount_path
    dst = dst_spec.mount_path
    store = accessor.store
    s, d = norm(src), norm(dst)
    now = now_iso()
    await check_dest_parents(store, dst_spec, d)
    if await store.has_file(s):
        data = await store.get_file(s) or b""
        mod = await store.get_modified(s)
        attrs = await store.get_attrs(s)
        await store.del_file(s)
        await store.del_modified(s)
        await store.del_attrs(s)
        await store.set_file(d, data)
        await store.set_modified(d, mod or now)
        if attrs:
            await store.set_attrs(d, attrs)
    elif await store.has_dir(s):
        mod = await store.get_modified(s)
        attrs = await store.get_attrs(s)
        await store.remove_dir(s)
        await store.del_modified(s)
        await store.del_attrs(s)
        await store.add_dir(d)
        await store.set_modified(d, mod or now)
        if attrs:
            await store.set_attrs(d, attrs)
        await _move_subtree(store, s, d)
    else:
        raise FileNotFoundError(s)
    await invalidate_subtree(dst_spec)
    await invalidate_subtree(src_spec)
