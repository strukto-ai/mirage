from mirage.accessor.chroma import ChromaAccessor
from mirage.commands.builtin.chroma import COMMANDS
from mirage.core.chroma.glob import resolve_glob as _resolve_glob
from mirage.core.chroma.read import read_bytes, read_stream
from mirage.core.chroma.readdir import readdir
from mirage.core.chroma.stat import stat
from mirage.ops.chroma import OPS as CHROMA_VFS_OPS
from mirage.resource.base import BaseResource
from mirage.resource.chroma.config import ChromaConfig
from mirage.resource.chroma.prompt import PROMPT
from mirage.types import ResourceName

_CHROMA_OPS = {
    "read_bytes": read_bytes,
    "read_stream": read_stream,
    "readdir": readdir,
    "stat": stat,
}


class ChromaResource(BaseResource):

    accessor: ChromaAccessor
    name: str = ResourceName.CHROMA
    caches_reads: bool = False
    _ops = _CHROMA_OPS
    PROMPT: str = PROMPT
    SUPPORTS_SNAPSHOT: bool = False

    def __init__(self, config: ChromaConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = ChromaAccessor(config)

        for fn in COMMANDS:
            self.register(fn)
        for fn in CHROMA_VFS_OPS:
            self.register_op(fn)

    async def resolve_glob(self, paths, prefix: str = ""):
        return await _resolve_glob(self.accessor, paths, index=self._index)

    def get_state(self) -> dict:
        return {
            "type": self.name,
            "needs_override": True,
            "redacted_fields": [],
            "config": self.config.model_dump(),
        }

    def load_state(self, state: dict) -> None:
        pass
