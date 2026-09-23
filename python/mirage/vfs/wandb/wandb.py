from typing import Any

from mirage.accessor.wandb import WandbAccessor
from mirage.commands.builtin.wandb import COMMANDS
from mirage.commands.builtin.wandb.io import IO
from mirage.core.wandb.config import WandbConfig
from mirage.core.wandb.read import read
from mirage.core.wandb.readdir import readdir
from mirage.core.wandb.stat import stat
from mirage.ops.wandb import OPS
from mirage.types import PathSpec, VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.wandb.prompt import PROMPT


class WandbVFS(BaseVFS):
    name: str = VFSName.WANDB
    PROMPT: str = PROMPT
    _ops: dict[str, Any] = {
        "read_bytes": read,
        "readdir": readdir,
        "stat": stat
    }

    def __init__(self, config: WandbConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = WandbAccessor(config)
        for command in COMMANDS:
            self.register(command)
        for op in OPS:
            self.register_op(op)

    async def resolve_glob(self,
                           paths: list[PathSpec],
                           prefix: str = "") -> list[PathSpec]:
        return await IO.resolve_glob(self.accessor, paths, index=self._index)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
