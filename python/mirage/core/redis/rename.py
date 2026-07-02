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
from mirage.cache.context import (invalidate_after_unlink,
                                  invalidate_after_write)
from mirage.core.timeutil import now_iso
from mirage.types import PathSpec
from mirage.utils.path import norm


async def rename(
    accessor: RedisAccessor,
    src: PathSpec,
    dst: PathSpec,
) -> None:
    if isinstance(src, str):
        src = PathSpec(virtual=src,
                       directory=src,
                       resource_path=src.strip("/"))
    if isinstance(src, PathSpec):
        src = src.mount_path
    if isinstance(dst, str):
        dst = PathSpec(virtual=dst,
                       directory=dst,
                       resource_path=dst.strip("/"))
    if isinstance(dst, PathSpec):
        dst = dst.mount_path
    store = accessor.store
    s, d = norm(src), norm(dst)
    now = now_iso()
    if await store.has_file(s):
        data = await store.get_file(s)
        mod = await store.get_modified(s)
        await store.del_file(s)
        await store.del_modified(s)
        await store.set_file(d, data)
        await store.set_modified(d, mod or now)
    elif await store.has_dir(s):
        mod = await store.get_modified(s)
        await store.remove_dir(s)
        await store.del_modified(s)
        await store.add_dir(d)
        await store.set_modified(d, mod or now)
        prefix = s.rstrip("/") + "/"
        all_files = await store.list_files()
        for key in all_files:
            if key.startswith(prefix):
                new_key = d.rstrip("/") + "/" + key[len(prefix):]
                data = await store.get_file(key)
                await store.del_file(key)
                await store.set_file(new_key, data)
    else:
        raise FileNotFoundError(s)
    await invalidate_after_write(d)
    await invalidate_after_unlink(s)
