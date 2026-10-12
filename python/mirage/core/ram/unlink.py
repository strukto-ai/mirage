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
from mirage.cache.context import invalidate_after_unlink
from mirage.core.dev.device import active_pipe
from mirage.core.ram.dest import lookup_error
from mirage.errors.fs import eisdir, fs_error
from mirage.errors.types import FsCondition
from mirage.types import PathSpec
from mirage.utils.path import norm


async def unlink(accessor: RAMAccessor, path_spec: PathSpec) -> None:
    """Remove one key.

    A live descriptor is the shell's to release when its command ends,
    so unlinking one is EPERM and it stays readable (GNU: ``rm
    /dev/fd/63`` is "Operation not permitted").

    Args:
        accessor (RAMAccessor): the RAM accessor.
        path_spec (PathSpec): the key to remove.
    """
    path = path_spec.mount_path
    store = accessor.store
    p = norm(path)
    if active_pipe(accessor, p) is not None:
        raise fs_error(path_spec, FsCondition.EPERM)
    if p in store.dirs:
        raise eisdir(path_spec)
    if p not in store.files:
        raise lookup_error(store, path_spec, p)
    del store.files[p]
    store.modified.pop(p, None)
    store.attrs.pop(p, None)
    await invalidate_after_unlink(path_spec)
