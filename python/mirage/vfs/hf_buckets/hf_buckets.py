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
from mirage.commands.builtin.hf_buckets.io import IO
from mirage.core.hf_buckets.watch import build_delta_hook
from mirage.ops.hf_buckets import OPS as HF_OPS
from mirage.types import VFSName
from mirage.vfs.bound import BoundVFS
from mirage.vfs.hf_buckets.prompt import PROMPT
from mirage.watch.base import DeltaHook


class HfBucketsVFS(BoundVFS):

    accessor: HfBucketsAccessor
    name: str = VFSName.HF_BUCKETS
    caches_reads: bool = True
    # The Hub tree API reports each file's exact byte size (the LFS
    # object size for LFS files); readdir backfills any lister-omitted
    # size with one stat.
    SIZES_ALWAYS_KNOWN: bool = True
    PROMPT: str = PROMPT
    SUPPORTS_SNAPSHOT: bool = True
    # stat stamps the paths-info xet hash and a read stamps its download's
    # strong ETag, which is that same hash, so a `fresh` probe compares
    # like with like.
    READ_REVALIDATABLE: bool = True

    def __init__(self, config: HfBucketsConfig) -> None:
        super().__init__(io=IO)
        self.config = config
        self.accessor = HfBucketsAccessor(self.config)
        for fn in HF_COMMANDS:
            self.register(fn)
        for op in HF_OPS:
            self.register_op(op)

    def delta_hook(self) -> DeltaHook:
        return build_delta_hook(self.accessor)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
