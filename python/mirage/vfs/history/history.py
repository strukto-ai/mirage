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

from typing import Any

from mirage.accessor.history import HistoryAccessor
from mirage.core.history.read import read as _read
from mirage.core.history.readdir import readdir as _readdir
from mirage.core.history.stat import stat as _stat
from mirage.observe.observer import Observer
from mirage.types import FileStat, PathSpec
from mirage.vfs.base import BaseVFS

HISTORY_PREFIX = "/.bash_history"


class HistoryViewVFS(BaseVFS):
    """Read-only view VFS backing the /.bash_history mount.

    Renders GNU views from the workspace's hidden recorder on every
    read; holds no storage of its own.

    Args:
        observer (Observer): The workspace's hidden recorder.
    """

    accessor: HistoryAccessor

    name = "history"
    # The view renders from in-memory events, so stat() sizes it by
    # rendering: cheap, no network, and never None.
    sizes_always_known: bool = True

    def __init__(self, observer: Observer) -> None:
        super().__init__()
        self.observer = observer
        self.accessor = HistoryAccessor(observer)

    async def readdir(self, path: PathSpec) -> list[FileStat]:
        return await _readdir(self.accessor, path)

    async def read(self, path: PathSpec) -> bytes:
        return await _read(self.accessor, path)

    async def stat(self, path: PathSpec) -> FileStat:
        return await _stat(self.accessor, path)

    def get_state(self) -> dict[str, Any]:
        return {"type": self.name}
