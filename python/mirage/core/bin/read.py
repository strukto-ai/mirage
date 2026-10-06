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

from mirage.accessor.bin import BinAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.bin.render import render_stub
from mirage.errors.fs import eisdir, enoent
from mirage.types import PathSpec


async def read(
    accessor: BinAccessor, path: PathSpec, index: IndexCacheStore = NULL_INDEX
) -> bytes:
    """Render one program's file.

    Args:
        accessor (BinAccessor): Accessor holding the lookup.
        path (PathSpec): Virtual path under the view.
        index (IndexCacheStore): Unused; op signature parity.

    Returns:
        bytes: The program's stub, fresh on every call.
    """
    key = path.mount_path.strip("/")
    if key == "":
        raise eisdir(path)
    note = None if "/" in key else accessor.note(key)
    if note is None:
        raise enoent(path)
    return render_stub(key, note)
