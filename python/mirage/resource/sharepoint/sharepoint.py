import dataclasses
from typing import Any

from mirage.accessor.sharepoint import SharePointAccessor, SharePointConfig
from mirage.commands.builtin.sharepoint import COMMANDS as SHAREPOINT_COMMANDS
from mirage.core.sharepoint.copy import copy
from mirage.core.sharepoint.create import create
from mirage.core.sharepoint.du import du, du_all
from mirage.core.sharepoint.exists import exists
from mirage.core.sharepoint.find import find
from mirage.core.sharepoint.mkdir import mkdir
from mirage.core.sharepoint.read import read_bytes
from mirage.core.sharepoint.readdir import readdir
from mirage.core.sharepoint.rename import rename
from mirage.core.sharepoint.rm import rm_r
from mirage.core.sharepoint.rmdir import rmdir
from mirage.core.sharepoint.stat import stat as sharepoint_stat
from mirage.core.sharepoint.stream import range_read, read_stream
from mirage.core.sharepoint.truncate import truncate
from mirage.core.sharepoint.unlink import unlink
from mirage.core.sharepoint.write import write_bytes
from mirage.ops.sharepoint import OPS as SHAREPOINT_OPS
from mirage.resource.base import BaseResource
from mirage.resource.sharepoint.prompt import PROMPT
from mirage.types import PathSpec, ResourceName
from mirage.utils.glob_walk import make_resolve_glob
from mirage.utils.key_prefix import mount_key

_resolve_glob = make_resolve_glob(readdir)

_SHAREPOINT_OPS = {
    "read_bytes": read_bytes,
    "write": write_bytes,
    "readdir": readdir,
    "stat": sharepoint_stat,
    "unlink": unlink,
    "rmdir": rmdir,
    "copy": copy,
    "rename": rename,
    "mkdir": mkdir,
    "read_stream": read_stream,
    "range_read": range_read,
    "rm_recursive": rm_r,
    "du_total": du,
    "du_all": du_all,
    "create": create,
    "truncate": truncate,
    "exists": exists,
    "find_flat": find,
}


class SharePointResource(BaseResource):

    accessor: SharePointAccessor
    name: str = ResourceName.SHAREPOINT
    caches_reads: bool = True
    _ops: dict[str, Any] = _SHAREPOINT_OPS
    PROMPT: str = PROMPT
    SUPPORTS_SNAPSHOT: bool = True

    def __init__(self, config: SharePointConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = SharePointAccessor(self.config)
        for fn in SHAREPOINT_COMMANDS:
            self.register(fn)
        for fn in SHAREPOINT_OPS:
            self.register_op(fn)

    async def resolve_glob(self, paths, prefix: str = ""):
        if prefix:
            paths = [
                dataclasses.replace(p,
                                    resource_path=mount_key(p.virtual, prefix))
                if isinstance(p, PathSpec) else p for p in paths
            ]
        return await _resolve_glob(self.accessor, paths, self._index)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)

    def load_state(self, state: dict[str, Any]) -> None:
        pass
