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
from mirage.core.dev.constants import DEV_RDEV
from mirage.core.dev.device import active_device, active_pipe
from mirage.core.ram.dest import lookup_error
from mirage.core.ram.stat import key_stat as ram_key_stat
from mirage.types import DEVICE_NUMBERS_KEY, FileStat, FileType, PathSpec
from mirage.utils.path import norm
from mirage.utils.stat_view import FIFO_MODE


def key_stat(accessor: RAMAccessor, p: str) -> FileStat | None:
    """What ``stat`` answers for the normalized key ``p``, None when
    nothing is there.

    Args:
        accessor (RAMAccessor): the /dev store's accessor.
        p (str): the normalized key.
    """
    store = accessor.store
    attrs = store.attrs.get(p, {})
    if active_pipe(accessor, p) is not None:
        mode = attrs.get("mode")
        return FileStat(
            name=p.rsplit("/", 1)[-1],
            size=None,
            modified=store.modified.get(p),
            type=FileType.FIFO,
            mode=FIFO_MODE & 0o7777 if mode is None else mode,
            uid=attrs.get("uid"),
            gid=attrs.get("gid"),
            atime=attrs.get("atime"),
        )
    device = active_device(accessor, p)
    if device is None:
        return ram_key_stat(store, p)
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


async def stat(accessor: RAMAccessor, path_spec: PathSpec) -> FileStat:
    """Stat a /dev path: a FIFO for a live descriptor, a char device for
    an active synthetic name, otherwise the ordinary RAM stat (a
    recreated real file, or a dir).

    Neither has rendered content, so the size is None; a device's
    identity is the [major, minor] under DEVICE_NUMBERS_KEY. Both carry
    the stored mode, owner and times; a FIFO without a mode is rw-------.

    Args:
        accessor (RAMAccessor): the /dev store's accessor.
        path_spec (PathSpec): the path to stat.
    """
    p = norm(path_spec.mount_path)
    found = key_stat(accessor, p)
    if found is None:
        raise lookup_error(accessor.store, path_spec, p)
    return found
