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
    src_spec: str | PathSpec,
    dst_spec: str | PathSpec,
) -> None:
    src = src_spec.mount_path if isinstance(src_spec, PathSpec) else src_spec
    dst = dst_spec.mount_path if isinstance(dst_spec, PathSpec) else dst_spec
    store = accessor.store
    s, d = norm(src), norm(dst)
    now = now_iso()
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
        prefix = s.rstrip("/") + "/"
        all_files = await store.list_files()
        for key in all_files:
            if key.startswith(prefix):
                new_key = d.rstrip("/") + "/" + key[len(prefix):]
                data = await store.get_file(key) or b""
                sub_attrs = await store.get_attrs(key)
                await store.del_file(key)
                await store.del_attrs(key)
                await store.set_file(new_key, data)
                if sub_attrs:
                    await store.set_attrs(new_key, sub_attrs)
    else:
        raise FileNotFoundError(s)
    await invalidate_after_write(d)
    await invalidate_after_unlink(s)
