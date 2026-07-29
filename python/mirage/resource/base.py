# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

from functools import partial
from typing import Any, Callable

from pydantic import BaseModel

from mirage.accessor.base import Accessor
from mirage.cache.index import (IndexCacheStore, IndexConfig,
                                RAMIndexCacheStore, RedisIndexConfig)
from mirage.commands.config import RegisteredCommand
from mirage.ops.registry import RegisteredOp
from mirage.resource.secrets import redacted_config_dump
from mirage.types import CapacityResult, CapacityState, PathSpec

try:
    from mirage.cache.index import RedisIndexCacheStore
except ImportError:
    RedisIndexCacheStore = None


class BaseResource:

    name: str = "base"
    caches_reads: bool = False
    accessor: Accessor = Accessor()
    _ops: dict[str, Callable[..., Any]] = {}
    PROMPT: str = ""
    WRITE_PROMPT: str = ""

    index_ttl: float = 600

    # Whether this resource carries enough version information for
    # snapshot+replay drift detection. When True, the resource's stat()
    # must populate FileStat.fingerprint with a stable per-path marker
    # (ETag, md5, commit SHA, etc.) that distinguishes content versions.
    # When False (the default), reads are treated as live-only at replay
    # time: no fingerprint is recorded at snapshot, no drift check fires
    # at load. See docs/home/snapshot.mdx for the contract.
    SUPPORTS_SNAPSHOT: bool = False

    def __init__(
        self,
        index: IndexConfig | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        self._closed = False
        self._commands: list[RegisteredCommand] = []
        self._ops_list: list[RegisteredOp] = []
        self._index: IndexCacheStore
        self.set_index(index)

    def set_index(self, config: IndexConfig | None = None) -> None:
        cfg = (config if config is not None else IndexConfig(
            ttl=self.index_ttl))
        if isinstance(cfg, RedisIndexConfig):
            if RedisIndexCacheStore is None:
                raise ImportError(
                    "RedisIndexConfig requires the 'redis' extra. "
                    "Install with: pip install mirage-ai[redis]")
            self._index = RedisIndexCacheStore(
                ttl=cfg.ttl,
                url=cfg.url,
                key_prefix=cfg.key_prefix,
            )
        else:
            self._index = RAMIndexCacheStore(ttl=cfg.ttl)

    @property
    def index(self) -> IndexCacheStore:
        return self._index

    async def resolve_glob(self,
                           paths: list[str | PathSpec],
                           prefix: str = "") -> list[PathSpec]:
        raise NotImplementedError

    async def statfs(self) -> CapacityResult:
        """Capacity of this backend for df. Default: UNKNOWN (rendered as
        ``-``). Backends that can report truthfully — a real filesystem, or
        a provider that exposes a storage quota — override this. Never
        fabricate a number: report QUOTA only with real values, else
        ELASTIC/NA/UNKNOWN.
        """
        return CapacityResult(state=CapacityState.UNKNOWN)

    def __getattr__(self, name: str) -> Any:
        fn = type(self)._ops.get(name)
        if fn is not None:
            return partial(fn, self.accessor)
        raise AttributeError(
            f"'{type(self).__name__}' has no attribute '{name}'")

    def register_op(self, fn: Any) -> None:
        if isinstance(fn, RegisteredOp):
            self._ops_list.append(fn)
            return
        for ro in fn._registered_ops:
            self._ops_list.append(ro)

    def ops_list(self) -> list[RegisteredOp]:
        return self._ops_list

    def register(self, fn: Any) -> None:
        for rc in fn._registered_commands:
            self._commands.append(rc)

    def commands(self) -> list[RegisteredCommand]:
        return self._commands

    def get_state(self) -> dict[str, Any]:
        return {
            "type": self.name,
        }

    def config_state(self, config: BaseModel, **extra: Any) -> dict[str, Any]:
        cfg = redacted_config_dump(config)
        return {
            "type": self.name,
            "config": cfg,
            **extra,
        }

    def load_state(self, state: dict[str, Any]) -> None:
        pass

    async def close(self) -> None:
        if self._closed:
            return
        await self.accessor.close()
        await self._index.close()
        self._closed = True
