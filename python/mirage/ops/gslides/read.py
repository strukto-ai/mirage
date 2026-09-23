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

from mirage.accessor.gslides import GSlidesAccessor
from mirage.core.gslides.read import read as core_read
from mirage.ops.registry import op
from mirage.types import PathSpec
from mirage.utils.ranges import slice_window


@op("read", vfs=["gslides", "gdrive"], filetype=".gslide.json")
async def read(accessor: GSlidesAccessor,
               path: PathSpec,
               *,
               index,
               offset: int = 0,
               size: int | None = None,
               **kwargs) -> bytes:
    """Read the rendered document, optionally only a byte range of it.

    A backend that registers its own read op does not go through the
    generic factory, so the read-and-slice fallback never reaches it and
    the window has to be applied here. These bytes are rendered, so
    there is nothing to push down.

    Args:
        accessor (GSlidesAccessor): the backend handle.
        path (PathSpec): the path to read.
        index: the index cache the readdir populated.
        offset (int): first byte to keep.
        size (int | None): how many bytes, or None for the rest.
    """
    if size == 0:
        return b""
    data = await core_read(accessor, path, index)
    if offset == 0 and size is None:
        return data
    return slice_window(data, offset, size)
