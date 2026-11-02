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

- Read only. Only configured entities are visible. Run IDs are stable;
  display names may repeat.
- `run.json` holds identity, creator, sweep/group/job, tags, timestamps,
  notes, system metrics, history keys and count, and file count. Its
  `user` contains the creator's id, name, username and email, when
  available; its `read_only` is W&B's permission, not the mount mode.
  Missing run metadata is `null`.
- `history.jsonl` scans unsampled history in original order, preserving
  missing metrics and `_step`. Logged training-step keys are independent
  of `_step`. History reads may be large; use `head` to stream a prefix.
- `summary.json` metrics are stored values, not history maxima.
- `files/` keeps run-relative paths; `files/wandb-metadata.json`, when
  present, describes the machine and runtime environment.
- Listings and reads are lazy."""


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
