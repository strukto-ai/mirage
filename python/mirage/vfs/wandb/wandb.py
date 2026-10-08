from collections.abc import AsyncIterator
from typing import Any

from mirage.accessor.wandb import WandbAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.wandb.config import WandbConfig
from mirage.core.wandb.read import read, read_stream
from mirage.core.wandb.readdir import readdir
from mirage.core.wandb.stat import stat
from mirage.types import FileStat, PathSpec, VFSName
from mirage.utils.ranges import slice_window
from mirage.vfs.base import BaseVFS
from mirage.vfs.wandb.prompt import PROMPT


class WandbVFS(BaseVFS):
    accessor: WandbAccessor
    name: str = VFSName.WANDB
    prompt: str = PROMPT
    max_du_entries: int | None = 1000

    def __init__(self, config: WandbConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = WandbAccessor(config)

    async def readdir(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> list[str]:
        return await readdir(self.accessor, path, index)

    async def read(
        self,
        path: PathSpec,
        index: IndexCacheStore = NULL_INDEX,
        offset: int = 0,
        size: int | None = None,
    ) -> bytes:
        data = await read(self.accessor, path, index)
        return slice_window(data, offset, size)

    async def stat(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> FileStat:
        return await stat(self.accessor, path, index)

    def read_stream(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> AsyncIterator[bytes]:
        return read_stream(self.accessor, path, index)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
