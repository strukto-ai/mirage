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
from mirage.watch.base import DeltaHook

try:
    from mirage.cache.index import RedisIndexCacheStore
except ImportError:
    RedisIndexCacheStore = None


class BaseResource:

    name: str = "base"
    caches_reads: bool = False
    accessor: Accessor = Accessor()
    _ops: dict[str, Callable[..., Any]] = {}
    # The ``resource:`` value the registry built this instance from, a
    # name (``"s3"``, ``"wiki"``) or a code reference
    # (``"./wiki.py:WikiResource"``), stamped by ``build_resource``; None
    # for an instance constructed in code. A snapshot records it beside
    # the class path so the loader can rebuild the mount through the
    # same door yaml used, which is the only door that knows a class
    # loaded from a script file. TypeScript keeps the same fact in a
    # table beside its ``Resource`` interface (``resourceRefOf``).
    resource_ref: str | None = None
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

    # Whether stat() can size every regular file without fetching its
    # content, i.e. FileStat.size is None only for directories. True for
    # byte stores that keep a length in their metadata (ram, disk, redis,
    # s3, gridfs); False for resources that render content on read, where
    # the size is unknowable until the bytes exist (slack, gmail, notion,
    # postgres rows.jsonl, dify documents).
    #
    # The FUSE path does not need this: direct_io + attr_timeout=0 +
    # hydrate-on-open make size-unknown files read correctly anyway. FSKit
    # has no direct_io equivalent, so a mount there is driven entirely by
    # the reported size and a False resource serves silent empty files.
    # The mount-time check (fuse/backend.py check_sizes) names such
    # mounts in a warning rather than refusing; see
    # docs/python/setup/fuse.mdx.
    SIZES_ALWAYS_KNOWN: bool = False

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
                           paths: list[PathSpec],
                           prefix: str = "") -> list[PathSpec]:
        raise NotImplementedError

    def storage_id(self) -> str:
        """Identity of the storage this resource reads and writes.

        Two mounts whose resources return the same value address the same
        bytes, so a move between them must refuse rather than copy the
        object over itself and then unlink the source. The default treats
        every instance as its own storage, which is the safe direction to
        be wrong in: a false "different" only keeps the pre-existing
        behavior, while a false "same" would refuse a legitimate move.
        Backends whose config pins the storage (a disk root, a bucket and
        key prefix) override this so two separately constructed instances
        pointing at one target still compare equal.
        """
        return f"{self.name}:{id(self):x}"

    async def statfs(self) -> CapacityResult:
        """Capacity of this backend for df. Default: UNKNOWN (rendered as
        ``-``). Backends that can report truthfully — a real filesystem, or
        a provider that exposes a storage quota — override this. Never
        fabricate a number: report QUOTA only with real values, else
        ELASTIC/NA/UNKNOWN.
        """
        return CapacityResult(state=CapacityState.UNKNOWN)

    def __getattr__(self, name: str) -> Any:
        # Read through the instance, not the class. A builtin sets ``_ops``
        # as a class attribute and resolves the same either way, but a kit
        # backend has no class of its own to hang one on and builds the map
        # per instance in ``GenericResource.__init__``; ``type(self)._ops``
        # read past it and reported every op the table carried as missing.
        # No recursion: ``_ops`` is always found, on the class if nowhere
        # else, so this lookup never re-enters ``__getattr__``.
        fn = self._ops.get(name)
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
        if isinstance(fn, RegisteredCommand):
            self._commands.append(fn)
            return
        for rc in fn._registered_commands:
            self._commands.append(rc)

    def commands(self) -> list[RegisteredCommand]:
        return self._commands

    def delta_hook(self) -> DeltaHook | None:
        """Hook a consumer's poll loop can pull deltas from, or None.

        None means this backend has no native change detection, which
        is most of them; a subclass that has one overrides this and
        narrows the return to ``DeltaHook``.

        Declaring it here rather than behind a capability protocol is
        deliberate. The protocol only ever answered "does this resource
        have one", which a None default answers with no ``isinstance``,
        no import, and no second place to keep in step. TypeScript has
        always done it this way (``deltaHook?()`` on ``Resource``).
        """
        return None

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

    @property
    def is_closed(self) -> bool:
        """Whether this instance has completed its resource lifecycle."""
        return self._closed

    async def close(self) -> None:
        if self._closed:
            return
        await self.accessor.close()
        await self._index.close()
        self._closed = True
