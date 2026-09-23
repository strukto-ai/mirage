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

import os
from pathlib import Path
from typing import Any

from mirage.accessor.disk import DiskAccessor
from mirage.commands.builtin.disk import COMMANDS as DISK_COMMANDS
from mirage.commands.config import RegisteredCommand
from mirage.commands.registry import registered_commands
from mirage.core.disk.watch import build_delta_hook
from mirage.ops.disk import OPS as DISK_OPS
from mirage.ops.registry import RegisteredOp
from mirage.types import CapacityResult, CapacityState, VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.disk.prompt import PROMPT
from mirage.watch.base import DeltaHook


class DiskVFS(BaseVFS):

    name: str = VFSName.DISK
    # byte store: stat() sizes every file from metadata
    sizes_always_known: bool = True
    accessor: DiskAccessor
    index_ttl: float = 60
    prompt: str = PROMPT

    def __init__(self, root: str) -> None:
        super().__init__()
        self.root = Path(root).resolve()
        # The mount root is infrastructure, not a path component a caller
        # asked for, so it is created here rather than on demand by the
        # first write: writes must report ENOENT for a missing parent the
        # way GNU does. Mirrors TypeScript's DiskVFS constructor.
        self.root.mkdir(parents=True, exist_ok=True)
        self.accessor = DiskAccessor(self.root)

    def ops(self) -> list[RegisteredOp]:
        return DISK_OPS

    def commands(self) -> list[RegisteredCommand]:
        return registered_commands(DISK_COMMANDS)

    def storage_location(self) -> str:
        # The resolved root is the storage: two DiskVFS instances built on the
        # same directory are one store, however they were spelled.
        return f"{self.name}:{self.root}"

    def delta_hook(self) -> DeltaHook:
        return build_delta_hook(self.accessor)

    async def capacity(self) -> CapacityResult:
        # A real filesystem reports real numbers (QUOTA). GNU df: used counts
        # reserved blocks (f_blocks - f_bfree), available excludes them
        # (f_bavail); both scaled by the fundamental block size.
        st = os.statvfs(self.root)
        frsize = st.f_frsize or st.f_bsize
        return CapacityResult(
            state=CapacityState.QUOTA,
            total=st.f_blocks * frsize,
            used=(st.f_blocks - st.f_bfree) * frsize,
            available=st.f_bavail * frsize,
            inodes=st.f_files,
            inodes_used=st.f_files - st.f_ffree,
            inodes_free=st.f_favail,
        )

    def get_state(self) -> dict[str, Any]:
        files: dict[str, bytes] = {}
        modes: dict[str, int] = {}
        for p in self.root.rglob("*"):
            if p.is_file():
                rel = p.relative_to(self.root).as_posix()
                files[rel] = p.read_bytes()
                # Capture the real inode mode: it is the base truth for
                # disk permissions (the sidecar is gone), so restore must
                # reapply it or a chmod would reset to the host umask.
                modes[rel] = p.stat().st_mode & 0o7777
        return {
            "type": self.name,
            "files": files,
            "modes": modes,
        }

    def load_state(self, state: dict[str, Any]) -> None:
        files = state.get("files", {})
        modes = state.get("modes", {})
        for rel, data in files.items():
            target = self.root / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            mode = modes.get(rel)
            if mode is not None:
                os.chmod(target, mode)
