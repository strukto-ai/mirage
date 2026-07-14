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
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.history.render import render_bash_history
from mirage.types import PathSpec

VIEW_NAME = ".bash_history"
VIEW_KEYS = ("", VIEW_NAME)


async def read(accessor: HistoryAccessor,
               path: PathSpec,
               index: IndexCacheStore = NULL_INDEX) -> bytes:
    """Render the GNU histfile from the recorder's command events.

    Args:
        accessor (HistoryAccessor): Accessor holding the recorder.
        path (PathSpec): Virtual path; only the view file resolves.
        index (IndexCacheStore): Unused; op signature parity.

    Returns:
        bytes: Rendered histfile content, fresh on every call.
    """
    key = path.mount_path if isinstance(path, PathSpec) else path
    if key.strip("/") not in VIEW_KEYS:
        raise FileNotFoundError(key)
    events = await accessor.observer.command_events()
    return render_bash_history(events).encode()
