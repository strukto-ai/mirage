from collections.abc import AsyncIterator
from typing import Any

from mirage.accessor.chroma import ChromaAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.chroma.read import read as _read
from mirage.core.chroma.read import read_stream as _read_stream
from mirage.core.chroma.search import search_many, search_resource
from mirage.core.chroma.stat import stat as _stat
from mirage.core.chroma.tree import CHROMA_TREE
from mirage.types import FileStat, PathSpec, VFSName
from mirage.utils.ranges import slice_window
from mirage.vfs.base import BaseVFS
from mirage.vfs.chroma.config import ChromaConfig
from mirage.vfs.chroma.prompt import PROMPT
from mirage.vfs.types import SearchQuery

_readdir = CHROMA_TREE.readdir


class ChromaVFS(BaseVFS):
    accessor: ChromaAccessor
    name: str = VFSName.CHROMA
    caches_reads: bool = False
    # Every file is sized exactly, by one chunk scan per directory the
    # caller stats; the path tree's own size is the producer's source
    # number and never becomes the reported byte length.
    sizes_always_known: bool = True
    prompt: str = PROMPT
    supports_snapshot: bool = False

    def __init__(self, config: ChromaConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = ChromaAccessor(config)

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
        data = await _read(self.accessor, path, index)
        return slice_window(data, offset, size)

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
