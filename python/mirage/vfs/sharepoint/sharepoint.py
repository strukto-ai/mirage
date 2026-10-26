from typing import Any

from mirage.accessor.sharepoint import SharePointAccessor, SharePointConfig
from mirage.core.sharepoint.copy import copy as _copy
from mirage.core.sharepoint.create import create as _create
from mirage.core.sharepoint.events import build_delta_hook
from mirage.core.sharepoint.exists import exists as _exists
from mirage.core.sharepoint.mkdir import mkdir as _mkdir
from mirage.core.sharepoint.read import read as _read
from mirage.core.sharepoint.readdir import readdir as _readdir
from mirage.core.sharepoint.readdir import tree as _tree
from mirage.core.sharepoint.rename import rename as _rename
from mirage.core.sharepoint.rm import rm_r as _rm_r
from mirage.core.sharepoint.rmdir import rmdir as _rmdir
from mirage.core.sharepoint.search import (
    files_containing as _files_containing,
)
from mirage.core.sharepoint.stat import stat as _stat
from mirage.core.sharepoint.stream import read_stream as _read_stream
from mirage.core.sharepoint.truncate import truncate as _truncate
from mirage.core.sharepoint.unlink import unlink as _unlink
from mirage.core.sharepoint.write import write as _write
from mirage.events.base import DeltaHook
from mirage.io.types import ByteSource
from mirage.types import DirListing, FileStat, PathSpec, VFSName
from mirage.vfs.base import BaseVFS

VFS_MD = """\
{prefix}
  SharePoint Enterprise document libraries. Multi-site, multi-drive discovery.
  Unscoped mounts use: /{site_name}/{library_name}/{path_to_file}
  Unscoped level 0 (ls /): lists all accessible SharePoint sites.
  Unscoped level 1 (ls /site/): lists document libraries (drives) in that site.
  Unscoped level 2+ (ls /site/lib/...): lists files and folders in the drive.
  IMPORTANT: This is a remote mount. Prefer targeted reads (grep, head) \
over full scans. Avoid cat on large files without piping to head/tail.
  File versions are retained, snapshots pin and read prior versions."""


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
    vfs_md: str = VFS_MD
    whole_word_search: bool = True
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
        self, path: PathSpec, limit: int | None = None
    ) -> list[FileStat] | DirListing:
        return await _readdir(self.accessor, path, limit)

    async def read(
        self,
        path: PathSpec,
        offset: int = 0,
        size: int | None = None,
    ) -> ByteSource:
        if not offset and size is None:
            return _read_stream(self.accessor, path)
        return await _read(self.accessor, path, offset, size)

    async def stat(self, path: PathSpec) -> FileStat:
        return await _stat(self.accessor, path)

    async def exists(self, path: PathSpec) -> bool:
        return await _exists(self.accessor, path)

    async def read_tree(
        self, path: PathSpec, limit: int | None = None
    ) -> dict[str, FileStat] | None:
        return await _tree(self.accessor, path, limit)

    async def write(
        self, path: PathSpec, data: ByteSource, *, atomic: bool = False
    ) -> None:
        await _write(self.accessor, path, data)

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
        await _copy(self.accessor, src, dst)

    async def truncate(
        self, path: PathSpec, length: int, no_create: bool = False
    ) -> None:
        await _truncate(self.accessor, path, length, no_create)

    def supports(self, name: str) -> bool:
        """Whether this VFS answers ``name``; with no walk limit it reads
        every file rather than ask the service's search.

        Args:
            name (str): the function name.
        """
        if name == "files_containing" and self.walk_limit < 0:
            return False
        return super().supports(name)

    async def files_containing(
        self,
        path: PathSpec,
        text: str,
        *,
        whole_word: bool,
        ignore_case: bool,
    ) -> list[PathSpec] | None:
        if not whole_word or self.walk_limit < 0:
            return None
        return await _files_containing(self.accessor, text, [path])

    def delta_hook(self) -> DeltaHook:
        return build_delta_hook(self.accessor)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
