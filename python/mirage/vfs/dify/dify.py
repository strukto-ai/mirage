from typing import Any

from mirage.accessor.dify import DifyAccessor
from mirage.commands.builtin.dify import COMMANDS
from mirage.commands.config import RegisteredCommand
from mirage.commands.registry import registered_commands
from mirage.ops.dify import OPS as DIFY_VFS_OPS
from mirage.ops.registry import RegisteredOp
from mirage.types import VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.dify.config import DifyConfig
from mirage.vfs.dify.prompt import PROMPT


class DifyVFS(BaseVFS):

    accessor: DifyAccessor
    name: str = VFSName.DIFY
    caches_reads: bool = True
    prompt: str = PROMPT
    supports_snapshot: bool = False

    def __init__(self, config: DifyConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = DifyAccessor(config)

    def ops(self) -> list[RegisteredOp]:
        return DIFY_VFS_OPS

    def commands(self) -> list[RegisteredCommand]:
        return registered_commands(COMMANDS)

    def get_state(self) -> dict[str, Any]:
        redacted = ["api_key"]
        config = self.config.model_dump()
        if config.get("api_key") is not None:
            config["api_key"] = "<REDACTED>"
        return {
            "type": self.name,
            "needs_override": True,
            "redacted_fields": redacted,
            "config": config,
        }

    def load_state(self, state: dict[str, Any]) -> None:
        pass
