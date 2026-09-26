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

from mirage.accessor.onedrive import OneDriveAccessor, OneDriveConfig
from mirage.commands.builtin.onedrive import COMMANDS as ONEDRIVE_COMMANDS
from mirage.commands.builtin.onedrive.io import IO
from mirage.core.onedrive.watch import build_delta_hook
from mirage.ops.onedrive import OPS as ONEDRIVE_OPS
from mirage.types import VFSName
from mirage.vfs.bound import BoundVFS
from mirage.vfs.onedrive.prompt import PROMPT
from mirage.watch.base import DeltaHook


class OneDriveVFS(BoundVFS):

    accessor: OneDriveAccessor
    name: str = VFSName.ONEDRIVE
    caches_reads: bool = True
    # Graph driveItems carry an exact byte `size` for every file in both
    # listings and item gets; folders (including the root) report None
    # with the aggregate storage number in extra.
    SIZES_ALWAYS_KNOWN: bool = True
    # An API-backed tree that changes rarely; a day-long index spares the
    # provider a full re-walk every 10 minutes. Mirrors the TypeScript
    # VFS.
    index_ttl: float = 86_400
    PROMPT: str = PROMPT
    SUPPORTS_SNAPSHOT: bool = True
    # stat and every read that can fill the cache stamp the item's cTag,
    # the read taking it before the bytes, so the gate compares like with
    # like.
    READ_REVALIDATABLE: bool = True

    def __init__(self, config: OneDriveConfig) -> None:
        super().__init__(io=IO)
        self.config = config
        self.accessor = OneDriveAccessor(self.config)
        for fn in ONEDRIVE_COMMANDS:
            self.register(fn)
        for op in ONEDRIVE_OPS:
            self.register_op(op)

    def delta_hook(self) -> DeltaHook:
        return build_delta_hook(self.accessor)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
