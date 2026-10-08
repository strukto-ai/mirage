from collections.abc import AsyncIterator
from typing import Any

from mirage.accessor.sharepoint import SharePointAccessor, SharePointConfig
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.generic.du import make_walked_du
from mirage.core.sharepoint.copy import copy as _copy
from mirage.core.sharepoint.create import create as _create
from mirage.core.sharepoint.exists import exists as _exists
from mirage.core.sharepoint.find import find as _find
from mirage.core.sharepoint.mkdir import mkdir as _mkdir
from mirage.core.sharepoint.read import read as _read
from mirage.core.sharepoint.readdir import readdir as _readdir
from mirage.core.sharepoint.rename import rename as _rename
from mirage.core.sharepoint.rm import rm_r as _rm_r
from mirage.core.sharepoint.rmdir import rmdir as _rmdir
from mirage.core.sharepoint.stat import stat as _stat
from mirage.core.sharepoint.stream import read_stream as _read_stream
from mirage.core.sharepoint.truncate import truncate as _truncate
from mirage.core.sharepoint.unlink import unlink as _unlink
from mirage.core.sharepoint.watch import build_delta_hook
from mirage.core.sharepoint.write import write as _write
from mirage.types import FileStat, PathSpec, VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.sharepoint.prompt import PROMPT
from mirage.vfs.types import DuEntries
from mirage.watch.base import DeltaHook

_du = make_walked_du(_stat, _readdir)


class SharePointVFS(BaseVFS):
    accessor: SharePointAccessor
    name: str = VFSName.SHAREPOINT
    caches_reads: bool = True
    # Graph drive items carry an exact content-length size and the site
    # and drive levels are plain directories; unlike onedrive there is
    # no aggregate-size root item.
    sizes_always_known: bool = True
    # An API-backed tree that changes rarely; a day-long index spares the
    # provider a full re-walk every 10 minutes. Mirrors the TypeScript
    # VFS.
    index_ttl: float = 86_400
    prompt: str = PROMPT
    supports_snapshot: bool = True
    # stat and every read that can fill the cache stamp the item's cTag,
    # the read taking it before the bytes, so the gate compares like with
    # like.
    read_revalidatable: bool = True

    reads_ranges: bool = True

    def __init__(self, config: SharePointConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = SharePointAccessor(self.config)

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
        return await _read(self.accessor, path, index, offset, size)

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
        return await _du.size(self.accessor, path, index)

    async def du_entries(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> DuEntries:
        return await _du.entries(self.accessor, path, index)

    async def write(self, path: PathSpec, data: bytes) -> None:
        await _write(self.accessor, path, data)

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

    async def dir_copy(self, src: PathSpec, dst: PathSpec) -> None:
        await _copy(self.accessor, src, dst)

    async def truncate(
        self, path: PathSpec, length: int, no_create: bool = False
    ) -> None:
        await _truncate(self.accessor, path, length, no_create)

    def delta_hook(self) -> DeltaHook:
        return build_delta_hook(self.accessor)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
