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

from mirage.accessor.s3 import S3Accessor, S3Config
from mirage.commands.builtin.s3 import COMMANDS as S3_COMMANDS
from mirage.commands.config import RegisteredCommand
from mirage.commands.registry import registered_commands
from mirage.core.s3.watch import build_delta_hook
from mirage.ops.registry import RegisteredOp
from mirage.ops.s3 import OPS as S3_OPS
from mirage.types import VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.s3.prompt import PROMPT
from mirage.watch.base import DeltaHook


class S3VFS(BaseVFS):

    accessor: S3Accessor
    name: str = VFSName.S3
    # byte store: stat() sizes every file from metadata
    sizes_always_known: bool = True
    caches_reads: bool = True
    prompt: str = PROMPT
    supports_snapshot: bool = True

    def __init__(self, config: S3Config) -> None:
        super().__init__()
        self.config = config
        self.accessor = S3Accessor(self.config)

    def ops(self) -> list[RegisteredOp]:
        return S3_OPS

    def commands(self) -> list[RegisteredCommand]:
        return registered_commands(S3_COMMANDS)

    def storage_location(self) -> str:
        # Endpoint, bucket and key prefix pin the object namespace. The
        # endpoint matters because the same bucket name on two providers
        # (AWS vs MinIO vs R2) is two different stores. The prefix joins
        # path-like so two mounts whose prefixes nest still resolve to
        # one key once the mount-relative path is appended.
        cfg = self.config
        prefix = (cfg.key_prefix or "").strip("/")
        base = f"{self.name}:{cfg.endpoint_url or 'aws'}:{cfg.bucket}"
        return f"{base}/{prefix}" if prefix else base

    def delta_hook(self) -> DeltaHook:
        return build_delta_hook(self.accessor)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)

    def load_state(self, state: dict[str, Any]) -> None:
        # No-op: S3VFS holds no local content. Reconstruction
        # happens via the mounts= override at load time.
        pass
