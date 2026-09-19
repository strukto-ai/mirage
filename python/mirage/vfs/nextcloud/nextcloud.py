from typing import Any

from pydantic import BaseModel, ConfigDict

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.commands.builtin.nextcloud import COMMANDS as NEXTCLOUD_COMMANDS
from mirage.commands.config import RegisteredCommand
from mirage.commands.registry import registered_commands
from mirage.core.nextcloud.watch import build_delta_hook
from mirage.ops.nextcloud import OPS as NEXTCLOUD_OPS
from mirage.ops.registry import RegisteredOp
from mirage.types import VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.nextcloud.prompt import PROMPT
from mirage.watch.base import DeltaHook


class NextcloudConfig(BaseModel):
    model_config = ConfigDict(frozen=True)

    url: str
    username: str | None = None
    password: str | None = None
    verify_ssl: bool = True
    timeout: int = 30


class NextcloudVFS(BaseVFS):

    accessor: NextcloudAccessor
    name: str = VFSName.NEXTCLOUD
    caches_reads: bool = True
    # WebDAV PROPFIND carries getcontentlength for every file; readdir
    # backfills any lister-omitted size with one stat per affected file.
    sizes_always_known: bool = True
    prompt: str = PROMPT
    supports_snapshot: bool = True

    def __init__(self, config: NextcloudConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = NextcloudAccessor(self.config)

    def ops(self) -> list[RegisteredOp]:
        return NEXTCLOUD_OPS

    def commands(self) -> list[RegisteredCommand]:
        return registered_commands(NEXTCLOUD_COMMANDS)

    def delta_hook(self) -> DeltaHook:
        return build_delta_hook(self.accessor)

    def get_state(self) -> dict[str, Any]:
        redacted = ["password"]
        cfg = self.config.model_dump()
        for f in redacted:
            if cfg.get(f) is not None:
                cfg[f] = "<REDACTED>"
        return {
            "type": self.name,
            "needs_override": True,
            "redacted_fields": redacted,
            "config": cfg,
        }

    def load_state(self, state: dict[str, Any]) -> None:
        pass
