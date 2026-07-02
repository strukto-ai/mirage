import dataclasses
from typing import Any

from pydantic import BaseModel, ConfigDict

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.commands.builtin.nextcloud import COMMANDS as NEXTCLOUD_COMMANDS
from mirage.core.nextcloud.glob import resolve_glob as _resolve_glob
from mirage.core.nextcloud.stat import stat as nextcloud_stat
from mirage.ops.nextcloud import OPS as NEXTCLOUD_OPS
from mirage.resource.base import BaseResource
from mirage.resource.nextcloud.prompt import PROMPT
from mirage.types import PathSpec, ResourceName
from mirage.utils.key_prefix import mount_key

_NEXTCLOUD_OPS: dict[str, Any] = {}


class NextcloudConfig(BaseModel):
    model_config = ConfigDict(frozen=True)

    url: str
    username: str | None = None
    password: str | None = None
    verify_ssl: bool = True
    timeout: int = 30


class NextcloudResource(BaseResource):

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

    async def resolve_glob(self, paths, prefix: str = ""):
        if prefix:
            paths = [
                dataclasses.replace(p,
                                    resource_path=mount_key(p.virtual, prefix))
                if isinstance(p, PathSpec) else p for p in paths
            ]
        return await _resolve_glob(self.accessor, paths, self._index)

    async def fingerprint(self, path: str) -> str | None:
        try:
            remote = await nextcloud_stat(self.accessor, path)
            return remote.extra.get("etag")
        except FileNotFoundError:
            return None

    def get_state(self) -> dict:
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

    def load_state(self, state: dict) -> None:
        pass
