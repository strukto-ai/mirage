from typing import Any

from mirage.accessor.wandb import WandbAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.wandb.config import WandbConfig
from mirage.core.wandb.read import read, read_stream
from mirage.core.wandb.readdir import readdir
from mirage.core.wandb.stat import stat
from mirage.io.types import ByteSource
from mirage.types import DirListing, FileStat, PathSpec, VFSName
from mirage.utils.ranges import slice_window
from mirage.vfs.base import BaseVFS
from mirage.vfs.wandb.prompt import PROMPT


class WandbVFS(BaseVFS):
    accessor: WandbAccessor
    name: str = VFSName.WANDB
    prompt: str = PROMPT

    def __init__(self, config: WandbConfig) -> None:
        super().__init__()
        self.config = config
        self.full_scan_limit = config.full_scan_limit
        self.accessor = WandbAccessor(config)

    async def readdir(
        self, path: PathSpec, index: IndexCacheStore | None = None
    ) -> list[FileStat] | DirListing:
        return await readdir(self.accessor, path, index)

    async def read(
        self, path: PathSpec, offset: int = 0, size: int | None = None
    ) -> ByteSource:
        if not offset and size is None:
            return read_stream(self.accessor, path)
        data = await read(self.accessor, path)
        return slice_window(data, offset, size)

    async def stat(
        self, path: PathSpec, entry: FileStat | None = None
    ) -> FileStat:
        return await stat(self.accessor, path, entry)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
