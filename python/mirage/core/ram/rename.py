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

from mirage.accessor.ram import RAMAccessor
from mirage.cache.context import (invalidate_after_unlink,
                                  invalidate_after_write)
from mirage.core.timeutil import now_iso
from mirage.types import PathSpec
from mirage.utils.path import norm


async def rename(accessor: RAMAccessor, src: PathSpec, dst: PathSpec) -> None:
    if isinstance(src, PathSpec):
        src = src.mount_path
    if isinstance(dst, PathSpec):
        dst = dst.mount_path
    store = accessor.store
    s, d = norm(src), norm(dst)
    now = now_iso()
    if s in store.files:
        store.files[d] = store.files.pop(s)
        store.modified[d] = store.modified.pop(s, now)
        if s in store.attrs:
            store.attrs[d] = store.attrs.pop(s)
    elif s in store.dirs:
        store.dirs.discard(s)
        store.dirs.add(d)
        store.modified[d] = store.modified.pop(s, now)
        if s in store.attrs:
            store.attrs[d] = store.attrs.pop(s)
        prefix = s.rstrip("/") + "/"
        for key in list(store.files):
            if key.startswith(prefix):
                new_key = d.rstrip("/") + "/" + key[len(prefix):]
                store.files[new_key] = store.files.pop(key)
                if key in store.attrs:
                    store.attrs[new_key] = store.attrs.pop(key)
    else:
        raise FileNotFoundError(s)
    await invalidate_after_write(dst)
    await invalidate_after_unlink(src)
