from typing import Any

from mirage.accessor.sharepoint import SharePointAccessor, SharePointConfig
from mirage.commands.builtin.sharepoint import COMMANDS as SHAREPOINT_COMMANDS
from mirage.commands.builtin.sharepoint.io import IO
from mirage.core.sharepoint.watch import build_delta_hook
from mirage.ops.sharepoint import OPS as SHAREPOINT_OPS
from mirage.types import VFSName
from mirage.vfs.bound import BoundVFS
from mirage.vfs.sharepoint.prompt import PROMPT
from mirage.watch.base import DeltaHook


class SharePointVFS(BoundVFS):

    accessor: SharePointAccessor
    name: str = VFSName.SHAREPOINT
    caches_reads: bool = True
    # Graph drive items carry an exact content-length size and the site
    # and drive levels are plain directories; unlike onedrive there is
    # no aggregate-size root item.
    SIZES_ALWAYS_KNOWN: bool = True
    # An API-backed tree that changes rarely; a day-long index spares the
    # provider a full re-walk every 10 minutes. Mirrors the TypeScript
    # VFS.
    index_ttl: float = 86_400
    PROMPT: str = PROMPT
    SUPPORTS_SNAPSHOT: bool = True
    # stat and every unpinned read stamp the item's cTag, the read taking
    # it before the bytes, so the gate compares like with like.
    READ_REVALIDATABLE: bool = True

    def __init__(self, config: SharePointConfig) -> None:
        super().__init__(io=IO)
        self.config = config
        self.accessor = SharePointAccessor(self.config)
        for fn in SHAREPOINT_COMMANDS:
            self.register(fn)
        for op in SHAREPOINT_OPS:
            self.register_op(op)

    def delta_hook(self) -> DeltaHook:
        return build_delta_hook(self.accessor)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
