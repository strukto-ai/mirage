from typing import Any

from mirage.accessor.dify import DifyAccessor
from mirage.core.dify.read import read as _read
from mirage.core.dify.read import read_stream as _read_stream
from mirage.core.dify.search import search_many
from mirage.core.dify.stat import stat as _stat
from mirage.core.dify.tree import DIFY_TREE
from mirage.io.types import ByteSource
from mirage.types import DirListing, FileStat, PathSpec, SearchQuery, VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.dify.config import DifyConfig

VFS_MD = """This is a Dify Knowledge Base mounted as a read-only filesystem.

All files are plain text assembled from Dify document segments, regardless of
their original extension. You can use cat, head, tail, grep, find, ls, and wc
on these files."""

_readdir = DIFY_TREE.readdir


class DifyVFS(BaseVFS):
    accessor: DifyAccessor
    name: str = VFSName.DIFY
    caches_reads: bool = True
    vfs_md: str = VFS_MD
    supports_snapshot: bool = False

    reads_ranges: bool = True

    def __init__(self, config: DifyConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = DifyAccessor(config)

    async def readdir(
        self, path: PathSpec, entry: FileStat | None = None
    ) -> DirListing:
        return await _readdir(self.accessor, path, entry)

    async def read(
        self,
        path: PathSpec,
        offset: int = 0,
        size: int | None = None,
        entry: FileStat | None = None,
    ) -> ByteSource:
        if not offset and size is None:
            return _read_stream(self.accessor, path, entry)
        return await _read(self.accessor, path, offset, size, entry)

    async def stat(
        self, path: PathSpec, entry: FileStat | None = None
    ) -> FileStat:
        return await _stat(self.accessor, path, entry)

    async def search(
        self, path: PathSpec, query: SearchQuery
    ) -> list[tuple[str, str]] | None:
        return await search_many(self.accessor, [path], query)

    async def search_many(
        self, paths: list[PathSpec], query: SearchQuery
    ) -> list[tuple[str, str]] | None:
        return await search_many(self.accessor, paths, query)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config, needs_override=True)
