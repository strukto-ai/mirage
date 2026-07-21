import dataclasses
from typing import Any

from pydantic import BaseModel, ConfigDict

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.commands.builtin.nextcloud import COMMANDS as NEXTCLOUD_COMMANDS
from mirage.core.nextcloud.constants import SCOPE_ERROR
from mirage.core.nextcloud.readdir import readdir
from mirage.core.nextcloud.watch import build_delta_hook
from mirage.ops.nextcloud import OPS as NEXTCLOUD_OPS
from mirage.resource.base import BaseResource
from mirage.resource.nextcloud.prompt import PROMPT
from mirage.types import PathSpec, ResourceName
from mirage.utils.glob_walk import make_resolve_glob
from mirage.utils.key_prefix import mount_key
from mirage.watch.base import DeltaHook

_resolve_glob = make_resolve_glob(readdir, SCOPE_ERROR)

_NEXTCLOUD_OPS: dict[str, Any] = {}


class NextcloudConfig(BaseModel):
    model_config = ConfigDict(frozen=True)

    url: str
    username: str | None = None
    password: str | None = None
    verify_ssl: bool = True
    timeout: int = 30


class NextcloudResource(BaseResource):

    accessor: NextcloudAccessor
    name: str = ResourceName.NEXTCLOUD
    caches_reads: bool = True
    _ops: dict[str, Any] = _NEXTCLOUD_OPS
    PROMPT: str = PROMPT
    SUPPORTS_SNAPSHOT: bool = True

    def __init__(self, config: NextcloudConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = NextcloudAccessor(self.config)
        for fn in NEXTCLOUD_COMMANDS:
            self.register(fn)
        for fn in NEXTCLOUD_OPS:
            self.register_op(fn)

    def delta_hook(self) -> DeltaHook:
        return build_delta_hook(self.accessor)

    async def resolve_glob(self, paths, prefix: str = ""):
        if prefix:
            paths = [
                dataclasses.replace(p,
                                    resource_path=mount_key(p.virtual, prefix))
                if isinstance(p, PathSpec) else p for p in paths
            ]
        return await _resolve_glob(self.accessor, paths, self._index)

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
