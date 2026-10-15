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
from mirage.core.dev.device import active_device, active_pipe
from mirage.core.ram.read import read as ram_read
from mirage.errors.fs import einval
from mirage.types import PathSpec
from mirage.utils.path import norm


async def read(
    accessor: RAMAccessor,
    path: PathSpec,
    offset: int = 0,
    size: int | None = None,
) -> bytes:
    """Read a /dev path.

    ``/dev/null`` is always empty. ``/dev/zero`` answers a ranged read
    (``size`` given) with exactly that many zeros at any offset, and
    refuses a whole read (``size`` is None) with EINVAL: an endless
    device cannot be materialized. A recreated real file reads normally.
    """
    pipe = active_pipe(accessor, norm(path.mount_path))
    if pipe is not None:
        return await pipe.read(path, size)
    device = active_device(accessor, norm(path.mount_path))
    if device is None:
        return await ram_read(accessor, path, offset, size)
    if device == "null":
        return b""
    if size is None:
        raise einval(
            path.virtual, "cannot read an endless device without a size"
        )
    return b"\x00" * size
