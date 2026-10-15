from collections.abc import AsyncIterator
from typing import Any

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.core.generic.rewrite import append_by_rewrite
from mirage.core.nextcloud.capacity import capacity as _capacity
from mirage.core.nextcloud.constants import SCOPE_ERROR
from mirage.core.nextcloud.copy import copy as _copy
from mirage.core.nextcloud.copy import dir_copy as _dir_copy
from mirage.core.nextcloud.create import create as _create
from mirage.core.nextcloud.exists import exists as _exists
from mirage.core.nextcloud.mkdir import mkdir as _mkdir
from mirage.core.nextcloud.read import read as _read
from mirage.core.nextcloud.readdir import readdir as _readdir
from mirage.core.nextcloud.rename import rename as _rename
from mirage.core.nextcloud.rm import rm_r as _rm_r
from mirage.core.nextcloud.rmdir import rmdir as _rmdir
from mirage.core.nextcloud.set_attrs import set_attrs as _set_attrs
from mirage.core.nextcloud.stat import stat as _stat
from mirage.core.nextcloud.stat import tree as _tree
from mirage.core.nextcloud.stream import read_stream as _read_stream
from mirage.core.nextcloud.truncate import truncate as _truncate
from mirage.core.nextcloud.unlink import unlink as _unlink
from mirage.core.nextcloud.write import write as _write
from mirage.types import CapacityResult, FileStat, PathSpec, VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.nextcloud.config import NextcloudConfig
from mirage.vfs.nextcloud.prompt import PROMPT


class NextcloudVFS(BaseVFS):
    accessor: NextcloudAccessor
    name: str = VFSName.NEXTCLOUD
    caches_reads: bool = True
    # WebDAV PROPFIND carries getcontentlength for every file; readdir
    # backfills any lister-omitted size with one stat per affected file.
    sizes_always_known: bool = True
    prompt: str = PROMPT
    supports_snapshot: bool = True

    reads_ranges: bool = True
    max_glob_matches: int | None = SCOPE_ERROR

    def __init__(self, config: NextcloudConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = NextcloudAccessor(self.config)

    async def readdir(self, path: PathSpec) -> list[FileStat]:
        return await _readdir(self.accessor, path)

    async def read(
        self, path: PathSpec, offset: int = 0, size: int | None = None
    ) -> bytes:
        if not offset and size is None:
            return await _read(self.accessor, path)
        return await _read(self.accessor, path, offset, size)

    async def stat(self, path: PathSpec) -> FileStat:
        return await _stat(self.accessor, path)

    async def read_tree(self, path: PathSpec) -> dict[str, FileStat] | None:
        return await _tree(self.accessor, path)

    def read_stream(self, path: PathSpec) -> AsyncIterator[bytes]:
        return _read_stream(self.accessor, path)

    async def exists(self, path: PathSpec) -> bool:
        return await _exists(self.accessor, path)

    async def write(self, path: PathSpec, data: bytes) -> None:
        await _write(self.accessor, path, data)

    async def append(self, path: PathSpec, data: bytes) -> None:
        await append_by_rewrite(self.read, self.write, self.stat, path, data)

    async def create(self, path: PathSpec) -> None:
        await _create(self.accessor, path)

    async def unlink(self, path: PathSpec) -> None:
        await _unlink(self.accessor, path)

    async def mkdir(self, path: PathSpec, parents: bool = False) -> None:
        await _mkdir(self.accessor, path, parents=parents)

    async def rmdir(self, path: PathSpec) -> None:
        await _rmdir(self.accessor, path)

    async def rm_r(self, path: PathSpec) -> Any:
        return await _rm_r(self.accessor, path)

    async def rename(self, src: PathSpec, dst: PathSpec) -> None:
        await _rename(self.accessor, src, dst)

    async def copy(self, src: PathSpec, dst: PathSpec) -> None:
        await _copy(self.accessor, src, dst)

    async def dir_copy(self, src: PathSpec, dst: PathSpec) -> None:
        await _dir_copy(self.accessor, src, dst)

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

    async def capacity(self) -> CapacityResult:
        return await _capacity(self.accessor)

    def storage_location(self) -> str:
        # The server and the user pin the WebDAV tree two mounts would
        # share: each user's files live in a tree of their own.
        cfg = self.config
        return f"{self.name}:{cfg.url.rstrip('/')}:{cfg.username or ''}"

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
