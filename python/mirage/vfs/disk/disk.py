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
import shutil
import stat
from pathlib import Path
from typing import Any

from mirage.accessor.disk import DiskAccessor
from mirage.commands.builtin.disk import COMMANDS as DISK_COMMANDS
from mirage.commands.config import RegisteredCommand, registered_commands
from mirage.core.disk.utils import (
    open_regular,
    resolve_inside_sync,
    walk_entries,
)
from mirage.core.disk.watch import build_delta_hook
from mirage.ops.disk import OPS as DISK_OPS
from mirage.ops.registry import RegisteredOp
from mirage.types import (
    CapacityResult,
    CapacityState,
    ListingVersion,
    PathSpec,
    VFSName,
)
from mirage.vfs.base import BaseVFS
from mirage.vfs.disk.prompt import PROMPT
from mirage.vfs.errors import VFSConfigError
from mirage.watch.base import DeltaHook


class DiskVFS(BaseVFS):
    name: str = VFSName.DISK
    # byte store: stat() sizes every file from metadata
    sizes_always_known: bool = True
    accessor: DiskAccessor
    index_ttl: float = 60
    prompt: str = PROMPT
    # Each folder's listing is stored at the folder's own version (inode
    # and change times, mirage.core.disk.listing_version), so a fresh
    # mount re-lists only the folders that changed. An instance built with
    # folder_versions=False declares NONE for itself; the class keeps
    # FOLDER for the spec table.
    listing_version: ListingVersion = ListingVersion.FOLDER

    def __init__(self, root: str, folder_versions: bool = True) -> None:
        """Args:
        root (str): the host directory the mount mirrors.
        folder_versions (bool): store each listing at its folder's
            version. Folder versions assume a local POSIX filesystem;
            turn them off for an NFS, SMB or FUSE root, whose change
            times may not move with the folder's entries.
        """
        if not isinstance(folder_versions, bool):
            raise VFSConfigError("disk: folder_versions: must be a boolean")
        super().__init__()
        self.folder_versions = folder_versions
        if not folder_versions:
            self.listing_version = ListingVersion.NONE
        self.root = Path(root).resolve()
        # The mount root is infrastructure, not a path component a caller
        # asked for, so it is created here rather than on demand by the
        # first write: writes must report ENOENT for a missing parent the
        # way GNU does. Mirrors TypeScript's DiskVFS constructor.
        self.root.mkdir(parents=True, exist_ok=True)
        self.accessor = DiskAccessor(self.root, folder_versions)

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
        """The mount's files, by reference.

        Each file is its host path, not its bytes: whoever consumes the
        state (a snapshot tar, a copy, a version commit) reads it then,
        one file at a time, so capturing a large tree costs no memory.
        The caller keeps the files still until it has read them.
        """
        files: dict[str, Path] = {}
        modes: dict[str, int] = {}
        for directory, _, names in walk_entries(self.root):
            for name in names:
                p = directory / name
                info = p.lstat()
                if stat.S_ISREG(info.st_mode):
                    rel = p.relative_to(self.root).as_posix()
                    files[rel] = p
                    modes[rel] = info.st_mode & 0o7777
        return {
            "type": self.name,
            "config": {
                "root": str(self.root),
                "folder_versions": self.folder_versions,
            },
            "files": files,
            "modes": modes,
        }

    def load_state(self, state: dict[str, Any]) -> None:
        """Write the state's files under the root.

        A file is bytes or a host path (a staged restore, or another
        disk mount's state); a path is copied in chunks, and one that
        already is the target (a copy over the same root) is left alone.
        """
        files = state.get("files", {})
        modes = state.get("modes", {})
        for rel, data in files.items():
            if Path(rel).is_absolute():
                raise ValueError(f"snapshot path must be relative: {rel}")
            spec = PathSpec.from_str_path("/" + rel)
            target = resolve_inside_sync(self.root, spec, rel)
            target.parent.mkdir(parents=True, exist_ok=True)
            if not isinstance(data, Path):
                target.write_bytes(data)
            elif not (target.exists() and os.path.samefile(data, target)):
                with open_regular(data) as src, target.open("wb") as out:
                    shutil.copyfileobj(src, out)
            mode = modes.get(rel)
            if mode is not None:
                os.chmod(target, mode)
