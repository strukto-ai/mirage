from typing import Any

from mirage.accessor.chroma import ChromaAccessor
from mirage.commands.builtin.chroma import COMMANDS
from mirage.commands.config import RegisteredCommand
from mirage.commands.registry import registered_commands
from mirage.ops.chroma import OPS as CHROMA_VFS_OPS
from mirage.ops.registry import RegisteredOp
from mirage.types import VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.chroma.config import ChromaConfig
from mirage.vfs.chroma.prompt import PROMPT


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

    def ops(self) -> list[RegisteredOp]:
        return CHROMA_VFS_OPS

    def commands(self) -> list[RegisteredCommand]:
        return registered_commands(COMMANDS)

    def get_state(self) -> dict[str, Any]:
        return {
            "type": self.name,
            "needs_override": True,
            "redacted_fields": [],
            "config": self.config.model_dump(),
        }

    def load_state(self, state: dict[str, Any]) -> None:
        pass
