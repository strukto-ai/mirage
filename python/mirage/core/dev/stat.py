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
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.dev.constants import DEV_RDEV
from mirage.core.dev.device import active_device, active_pipe
from mirage.core.ram.stat import stat as ram_stat
from mirage.types import DEVICE_NUMBERS_KEY, FileStat, FileType, PathSpec
from mirage.utils.path import norm


async def stat(
    accessor: RAMAccessor,
    path_spec: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> FileStat:
    """Stat a /dev path: a char device for an active synthetic name,
    otherwise the ordinary RAM stat (a recreated real file, or a dir).

    A device has no rendered content, so its size is None and its
    identity is the [major, minor] under DEVICE_NUMBERS_KEY.
    """
    store = accessor.store
    p = norm(path_spec.mount_path)
    pipe = active_pipe(accessor, p)
    if pipe is not None:
        return FileStat(
            name=p.rsplit("/", 1)[-1], type=FileType.FIFO, size=None
        )
    device = active_device(accessor, p)
    if device is None:
        return await ram_stat(accessor, path_spec, index)
    attrs = store.attrs.get(p, {})
    major, minor = DEV_RDEV[device]
    return FileStat(
        name=p.rsplit("/", 1)[-1],
        size=None,
        modified=store.modified.get(p),
        type=FileType.CHAR_DEVICE,
        content=None,
        mode=attrs.get("mode"),
        uid=attrs.get("uid"),
        gid=attrs.get("gid"),
        atime=attrs.get("atime"),
        extra={DEVICE_NUMBERS_KEY: [major, minor]},
    )
