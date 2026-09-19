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

from mirage.accessor.hf_buckets import HfBucketsAccessor, HfBucketsConfig
from mirage.commands.builtin.hf_buckets import COMMANDS as HF_COMMANDS
from mirage.commands.config import RegisteredCommand
from mirage.commands.registry import registered_commands
from mirage.core.hf_buckets.watch import build_delta_hook
from mirage.ops.hf_buckets import OPS as HF_OPS
from mirage.ops.registry import RegisteredOp
from mirage.types import VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.hf_buckets.prompt import PROMPT
from mirage.watch.base import DeltaHook


class HfBucketsVFS(BaseVFS):

    accessor: HfBucketsAccessor
    name: str = VFSName.HF_BUCKETS
    caches_reads: bool = True
    # The Hub tree API reports each file's exact byte size (the LFS
    # object size for LFS files); readdir backfills any lister-omitted
    # size with one stat.
    sizes_always_known: bool = True
    prompt: str = PROMPT
    supports_snapshot: bool = True

    def __init__(self, config: HfBucketsConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = HfBucketsAccessor(self.config)

    def ops(self) -> list[RegisteredOp]:
        return HF_OPS

    def commands(self) -> list[RegisteredCommand]:
        return registered_commands(HF_COMMANDS)

    def delta_hook(self) -> DeltaHook:
        return build_delta_hook(self.accessor)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)

    def load_state(self, state: dict[str, Any]) -> None:
        pass
