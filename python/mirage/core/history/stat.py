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

from mirage.accessor.history import HistoryAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.history.read import read
from mirage.types import FileStat, PathSpec
from mirage.utils.filetype import guess_type


async def stat(accessor: HistoryAccessor,
               path: PathSpec,
               index: IndexCacheStore | None = None) -> FileStat:
    """Stat the rendered histfile.

    Args:
        accessor (HistoryAccessor): Accessor holding the recorder.
        path (PathSpec): Virtual path; only the view file resolves.
        index (IndexCacheStore): Unused; op signature parity.

    Returns:
        FileStat: File entry sized to the current rendering.
    """
    data = await read(accessor, path, index)
    return FileStat(
        name=".bash_history",
        size=len(data),
        modified=None,
        type=guess_type(".bash_history"),
    )
