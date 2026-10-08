from collections.abc import AsyncIterator
from typing import Any

from mirage.accessor.dify import DifyAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.dify.read import read as _read
from mirage.core.dify.read import read_stream as _read_stream
from mirage.core.dify.search import search_many, search_resource
from mirage.core.dify.stat import stat as _stat
from mirage.core.dify.tree import DIFY_TREE
from mirage.types import FileStat, PathSpec, VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.dify.config import DifyConfig
from mirage.vfs.dify.prompt import PROMPT
from mirage.vfs.types import SearchQuery

_readdir = DIFY_TREE.readdir


class DifyVFS(BaseVFS):
    accessor: DifyAccessor
    name: str = VFSName.DIFY
    caches_reads: bool = True
    prompt: str = PROMPT
    supports_snapshot: bool = False

    reads_ranges: bool = True

    def __init__(self, config: DifyConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = DifyAccessor(config)

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

    async def search(
        self,
        path: PathSpec,
        query: SearchQuery,
        index: IndexCacheStore = NULL_INDEX,
    ) -> list[str] | None:
        return await search_resource(self.accessor, path, query, index)

    async def search_many(
        self,
        paths: list[PathSpec],
        query: SearchQuery,
        index: IndexCacheStore = NULL_INDEX,
    ) -> list[str] | None:
        return await search_many(self.accessor, paths, query, index)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config, needs_override=True)
