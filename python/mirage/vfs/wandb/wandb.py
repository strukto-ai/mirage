from typing import Any

from mirage.accessor.wandb import WandbAccessor
from mirage.commands.builtin.wandb import COMMANDS
from mirage.commands.config import RegisteredCommand
from mirage.commands.registry import registered_commands
from mirage.core.wandb.config import WandbConfig
from mirage.ops.registry import RegisteredOp
from mirage.ops.wandb import OPS
from mirage.types import VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.wandb.prompt import PROMPT


class WandbVFS(BaseVFS):
    name: str = VFSName.WANDB
    prompt: str = PROMPT

    def __init__(self, config: WandbConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = WandbAccessor(config)

    def ops(self) -> list[RegisteredOp]:
        return OPS

    def commands(self) -> list[RegisteredCommand]:
        return registered_commands(COMMANDS)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
