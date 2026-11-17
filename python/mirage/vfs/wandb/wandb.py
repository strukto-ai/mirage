from typing import Any

from mirage.accessor.wandb import WandbAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.wandb.config import WandbConfig
from mirage.core.wandb.read import read_stream
from mirage.core.wandb.readdir import readdir
from mirage.core.wandb.stat import stat
from mirage.io.types import ByteSource
from mirage.types import DirListing, FileStat, PathSpec, VFSName
from mirage.vfs.base import BaseVFS

VFS_MD = """\
```text
{prefix}
  <entity>/
    <project>/
      <run-id>/
        run.json
        config.json
        summary.json
        history.jsonl
        files/
```

- Read only; only configured entities are visible. Run ids are stable,
  display names may repeat.
- `run.json` holds identity, creator, sweep, group, tags, timestamps,
  notes and system metrics; its `read_only` is W&B's permission, not the
  mount mode.
- `history.jsonl` is the full unsampled history in logged order and can
  be large; `head` streams a prefix.
- `summary.json` holds stored values, not history maxima.
- `files/` keeps run-relative paths; `files/wandb-metadata.json`
  describes the machine and environment."""


class WandbVFS(BaseVFS):
    accessor: WandbAccessor
    name: str = VFSName.WANDB
    vfs_md: str = VFS_MD

    def __init__(self, config: WandbConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = WandbAccessor(config)

    async def readdir(
        self,
        path: PathSpec,
        index: IndexCacheStore | None = None,
        limit: int | None = None,
    ) -> list[FileStat] | DirListing:
        return await readdir(self.accessor, path, index, limit)

    async def read(self, path: PathSpec) -> ByteSource:
        return read_stream(self.accessor, path)

    async def stat(
        self, path: PathSpec, entry: FileStat | None = None
    ) -> FileStat:
        return await stat(self.accessor, path, entry)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
