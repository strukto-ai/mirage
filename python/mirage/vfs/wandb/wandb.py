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

VFS_MD = """Read-only W&B experiments: /<entity>/<project>/<run-id>/ contains
run.json (identity, creator, sweep/group/job, tags, timestamps, notes, system metrics,
history keys/count and file count), config.json, summary.json, history.jsonl and files/.
Run IDs are stable; display names may repeat. history.jsonl scans unsampled history
in original order, preserving missing metrics and _step. Logged training-step keys
are independent of _step. Summary metrics are stored values, not history maxima.
Listings and reads are lazy. History reads may be large; use head to stream a prefix.
Only configured entities are visible. Files retain their run-relative paths.
files/wandb-metadata.json, when present, describes the machine/runtime environment.
run.json user contains the creator's id, name, username and email, when available.
Missing run metadata is null. run.json read_only is W&B's permission, not mount mode.
"""


class WandbVFS(BaseVFS):
    accessor: WandbAccessor
    name: str = VFSName.WANDB
    vfs_md: str = VFS_MD

    def __init__(self, config: WandbConfig) -> None:
        super().__init__()
        self.config = config
        self.walk_limit = config.walk_limit
        self.accessor = WandbAccessor(config)

    async def readdir(
        self, path: PathSpec, index: IndexCacheStore | None = None
    ) -> list[FileStat] | DirListing:
        return await readdir(self.accessor, path, index)

    async def read(self, path: PathSpec) -> ByteSource:
        return read_stream(self.accessor, path)

    async def stat(
        self, path: PathSpec, entry: FileStat | None = None
    ) -> FileStat:
        return await stat(self.accessor, path, entry)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
