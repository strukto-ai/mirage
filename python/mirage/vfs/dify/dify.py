from typing import Any

from mirage.accessor.dify import DifyAccessor
from mirage.commands.builtin.dify import COMMANDS
from mirage.core.dify.read import read_bytes, read_stream
from mirage.core.dify.readdir import readdir
from mirage.core.dify.stat import stat
from mirage.ops.dify import OPS as DIFY_VFS_OPS
from mirage.types import PathSpec, VFSName
from mirage.utils.glob_walk import make_resolve_glob
from mirage.vfs.base import BaseVFS
from mirage.vfs.dify.config import DifyConfig
from mirage.vfs.dify.prompt import PROMPT

_resolve_glob = make_resolve_glob(readdir)

_DIFY_OPS = {
    "read_bytes": read_bytes,
    "read_stream": read_stream,
    "readdir": readdir,
    "stat": stat,
}


class DifyVFS(BaseVFS):

    accessor: DifyAccessor
    name: str = VFSName.DIFY
    caches_reads: bool = True
    _ops: dict[str, Any] = _DIFY_OPS
    PROMPT: str = PROMPT
    SUPPORTS_SNAPSHOT: bool = False

    def __init__(self, config: DifyConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = DifyAccessor(config)

        for fn in COMMANDS:
            self.register(fn)
        for fn in DIFY_VFS_OPS:
            self.register_op(fn)

    async def resolve_glob(
        self,
        paths: list[PathSpec],
        prefix: str = '',
    ) -> list[PathSpec]:
        return await _resolve_glob(self.accessor, paths, index=self._index)

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
