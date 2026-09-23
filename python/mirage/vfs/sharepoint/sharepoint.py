from typing import Any

from mirage.accessor.sharepoint import SharePointAccessor, SharePointConfig
from mirage.commands.builtin.sharepoint import COMMANDS as SHAREPOINT_COMMANDS
from mirage.commands.config import RegisteredCommand
from mirage.commands.registry import registered_commands
from mirage.core.sharepoint.watch import build_delta_hook
from mirage.ops.registry import RegisteredOp
from mirage.ops.sharepoint import OPS as SHAREPOINT_OPS
from mirage.types import VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.sharepoint.prompt import PROMPT
from mirage.watch.base import DeltaHook


class SharePointVFS(BaseVFS):

    accessor: SharePointAccessor
    name: str = VFSName.SHAREPOINT
    caches_reads: bool = True
    # Graph drive items carry an exact content-length size and the site
    # and drive levels are plain directories; unlike onedrive there is
    # no aggregate-size root item.
    sizes_always_known: bool = True
    # An API-backed tree that changes rarely; a day-long index spares the
    # provider a full re-walk every 10 minutes. Mirrors the TypeScript
    # VFS.
    index_ttl: float = 86_400
    prompt: str = PROMPT
    supports_snapshot: bool = True

    def __init__(self, config: SharePointConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = SharePointAccessor(self.config)

    def ops(self) -> list[RegisteredOp]:
        return SHAREPOINT_OPS

    def commands(self) -> list[RegisteredCommand]:
        return registered_commands(SHAREPOINT_COMMANDS)

    def delta_hook(self) -> DeltaHook:
        return build_delta_hook(self.accessor)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)

    def load_state(self, state: dict[str, Any]) -> None:
        pass
