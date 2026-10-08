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
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from mirage.accessor.disk import DiskAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.disk.append import append_bytes as _append
from mirage.core.disk.constants import SCOPE_ERROR
from mirage.core.disk.copy import copy as _copy
from mirage.core.disk.create import create as _create
from mirage.core.disk.du import entries as _du_entries
from mirage.core.disk.du import size as _du_size
from mirage.core.disk.exists import exists as _exists
from mirage.core.disk.find import find as _find
from mirage.core.disk.mkdir import mkdir as _mkdir
from mirage.core.disk.pwrite import pwrite as _pwrite
from mirage.core.disk.read import read as _read
from mirage.core.disk.read import read_range as _read_range
from mirage.core.disk.readdir import readdir as _readdir
from mirage.core.disk.rename import rename as _rename
from mirage.core.disk.rm import rm_r as _rm_r
from mirage.core.disk.rmdir import rmdir as _rmdir
from mirage.core.disk.set_attrs import set_attrs as _set_attrs
from mirage.core.disk.stat import stat as _stat
from mirage.core.disk.stream import read_stream as _read_stream
from mirage.core.disk.truncate import truncate as _truncate
from mirage.core.disk.unlink import unlink as _unlink
from mirage.core.disk.utils import (
    open_regular,
    resolve_inside_sync,
    walk_entries,
)
from mirage.core.disk.watch import build_delta_hook
from mirage.core.disk.write import write as _write
from mirage.types import (
    CapacityResult,
    CapacityState,
    FileStat,
    ListingVersion,
    PathSpec,
    VFSName,
)
from mirage.vfs.base import BaseVFS
from mirage.vfs.disk.prompt import PROMPT
from mirage.vfs.errors import VFSConfigError
from mirage.vfs.types import DuEntries
from mirage.watch.base import DeltaHook


class DiskVFS(BaseVFS):
    name: str = VFSName.DISK
    # byte store: stat() sizes every file from metadata
    sizes_always_known: bool = True
    max_du_entries: int | None = None
    accessor: DiskAccessor
    index_ttl: float = 60
    prompt: str = PROMPT
    # Each folder's listing is stored at the folder's own version (inode
    # and change times, mirage.core.disk.listing_version), so a fresh
    # mount re-lists only the folders that changed. An instance built with
    # folder_versions=False declares NONE for itself; the class keeps
    # FOLDER for the spec table.
    listing_version: ListingVersion = ListingVersion.FOLDER

    reads_ranges: bool = True
    local: bool = True
    max_glob_matches: int | None = SCOPE_ERROR

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

    async def readdir(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> list[str]:
        return await _readdir(self.accessor, path, index)

    async def read(
        self,
        path: PathSpec,
        index: IndexCacheStore = NULL_INDEX,
        offset: int = 0,
        size: int | None = None,
    ) -> bytes:
        if not offset and size is None:
            return await _read(self.accessor, path, index)
        return await _read_range(self.accessor, path, index, offset, size)

    async def stat(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> FileStat:
        return await _stat(self.accessor, path, index)

    def read_stream(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> AsyncIterator[bytes]:
        return _read_stream(self.accessor, path, index)

    async def exists(self, path: PathSpec) -> bool:
        return await _exists(self.accessor, path)

    async def find(
        self,
        path: PathSpec,
        index: IndexCacheStore = NULL_INDEX,
        **predicates: Any,
    ) -> list[str]:
        return await _find(self.accessor, path, index=index, **predicates)

    async def du_size(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> int:
        return await _du_size(self.accessor, path, index)

    async def du_entries(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> DuEntries:
        return await _du_entries(self.accessor, path, index)

    async def write(self, path: PathSpec, data: bytes) -> None:
        await _write(self.accessor, path, data)

    async def append(
        self,
        path: PathSpec,
        data: bytes,
        index: IndexCacheStore = NULL_INDEX,
    ) -> None:
        await _append(self.accessor, path, data)

    async def pwrite(
        self,
        path: PathSpec,
        data: bytes,
        offset: int,
        index: IndexCacheStore = NULL_INDEX,
    ) -> None:
        await _pwrite(self.accessor, path, data, offset)

    async def create(self, path: PathSpec) -> None:
        await _create(self.accessor, path)

    async def unlink(self, path: PathSpec) -> None:
        await _unlink(self.accessor, path)

    async def mkdir(self, path: PathSpec, parents: bool = False) -> None:
        await _mkdir(self.accessor, path, parents=parents)

    async def rmdir(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> None:
        await _rmdir(self.accessor, path, index)

    async def rm_r(self, path: PathSpec) -> Any:
        return await _rm_r(self.accessor, path)

    async def rename(self, src: PathSpec, dst: PathSpec) -> None:
        await _rename(self.accessor, src, dst)

    async def copy(self, src: PathSpec, dst: PathSpec) -> None:
        await _copy(self.accessor, src, dst)

    async def truncate(
        self, path: PathSpec, length: int, no_create: bool = False
    ) -> None:
        await _truncate(self.accessor, path, length, no_create)

    async def setattr(
        self,
        path: PathSpec,
        *,
        mode: int | None = None,
        uid: int | str | None = None,
        gid: int | str | None = None,
        atime: str | None = None,
        mtime: str | None = None,
    ) -> dict[str, int | str]:
        return await _set_attrs(
            self.accessor,
            path,
            mode=mode,
            uid=uid,
            gid=gid,
            atime=atime,
            mtime=mtime,
        )

    def is_mounted(self) -> bool:
        return self.accessor.root is not None

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
