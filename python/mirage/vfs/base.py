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
from mirage.types import CapacityResult, CapacityState, PathSpec
from mirage.vfs.secrets import redacted_config_dump
from mirage.watch.base import DeltaHook

try:
    from mirage.cache.index import RedisIndexCacheStore
except ImportError:
    RedisIndexCacheStore = None


class BaseVFS:

    name: str = "base"
    caches_reads: bool = False
    accessor: Accessor = Accessor()
    _ops: dict[str, Callable[..., Any]] = {}
    # The ``vfs:`` value the registry built this instance from, a
    # name (``"s3"``, ``"wiki"``) or a code reference
    # (``"./wiki.py:WikiVFS"``), stamped by ``build_vfs``; None
    # for an instance constructed in code. A snapshot records it beside
    # the class path so the loader can rebuild the mount through the
    # same door yaml used, which is the only door that knows a class
    # loaded from a script file. TypeScript keeps the same fact in a
    # table beside its ``VFS`` interface (``vfsRefOf``).
    vfs_ref: str | None = None
    PROMPT: str = ""
    WRITE_PROMPT: str = ""

    index_ttl: float = 600

    # Whether this VFS carries enough version information for
    # snapshot+replay drift detection. When True, the VFS's stat()
    # must populate FileStat.fingerprint with a stable per-path marker
    # (ETag, md5, commit SHA, etc.) that distinguishes content versions.
    # When False (the default), reads are treated as live-only at replay
    # time: no fingerprint is recorded at snapshot, no drift check fires
    # at load. See docs/home/snapshot.mdx for the contract.
    SUPPORTS_SNAPSHOT: bool = False

    # Whether stat() can size every regular file without fetching its
    # content, i.e. FileStat.size is None only for directories. True for
    # byte stores that keep a length in their metadata (ram, disk, redis,
    # s3, gridfs); False for mounts that render content on read, where
    # the size is unknowable until the bytes exist (slack, gmail, notion,
    # postgres rows.jsonl, dify documents).
    #
    # The FUSE path does not need this: direct_io + attr_timeout=0 +
    # hydrate-on-open make size-unknown files read correctly anyway. FSKit
    # has no direct_io equivalent, so a mount there is driven entirely by
    # the reported size and a False VFS serves silent empty files.
    # The mount-time check (fuse/backend.py check_sizes) names such
    # mounts in a warning rather than refusing; see
    # docs/python/setup/fuse.mdx.
    SIZES_ALWAYS_KNOWN: bool = False

    # Whether a `read: fresh` mount can actually be revalidated against
    # this backend: stat() and read must stamp FileStat.fingerprint /
    # the read record with the *same kind* of content token, so the gate
    # can compare them with ==. False (the default) is refused at mount
    # time rather than degraded, because a mount that declares fresh and
    # silently serves bounded is the bug the policy exists to prevent.
    #
    # Distinct from SUPPORTS_SNAPSHOT, which asks whether a token exists
    # at all, and from caches_reads, which asks whether the gate can
    # fire. A backend can have a token on both sides and still fail this
    # one, by stamping two different kinds.
    #
    # A declarer must stamp the token on every read, not only while a
    # recorder is active: tests/vfs/test_read_revalidatable.py holds each
    # one to that (#1165). onedrive and sharepoint qualify because every
    # unpinned byte read fetches the item's cTag before its bytes, recorded
    # or not; a stream stamps only under a recorder, the one place its token
    # can land.
    READ_REVALIDATABLE: bool = False

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
        """Expand the patterned specs in ``paths`` against this backend.

        ``prefix`` is the mount prefix without its trailing slash
        (``/mnt/lin``). Every caller stamps each spec's ``vfs_path`` with
        ``mount_key(virtual, prefix)`` before calling: the workspace
        expander, its mid-path and globstar walks, and the builtins'
        ``expand_operands`` (commands never come here; they glob through
        their ``CommandIO.resolve_glob``, which takes no prefix). So an
        implementation may read ``vfs_path`` and ignore ``prefix``, as the
        API backends do, and one that re-derives ``vfs_path`` from
        ``prefix``, as the storage backends and the typescript twins do,
        computes the same key. The re-derivation only matters to a caller
        outside the workspace handing over an unstamped spec
        (``PathSpec.from_str_path`` keys it from the root).

        Args:
            paths (list[PathSpec]): specs to expand, keyed under the mount.
            prefix (str): the owning mount's prefix, no trailing slash.

        Returns:
            list[PathSpec]: one spec per match.
        """
        raise NotImplementedError

    def storage_id(self) -> str:
        """Identity of the storage this VFS reads and writes.

        Two mounts whose mounts return the same value address the same
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
        deliberate. The protocol only ever answered "does this VFS
        have one", which a None default answers with no ``isinstance``,
        no import, and no second place to keep in step. TypeScript has
        always done it this way (``deltaHook?()`` on ``VFS``).
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
        """Take back what ``get_state`` put out.

        A no-op by default, which is right for every VFS whose bytes live
        in the remote service: its state is a redacted config, and the
        restored mount reaches its data through that config alone. Only a
        VFS holding content of its own (ram, disk, redis) overrides this.

        Args:
            state (dict[str, Any]): the payload ``get_state`` produced.
        """

    @property
    def is_closed(self) -> bool:
        """Whether this instance has completed its VFS lifecycle."""
        return self._closed

    async def close(self) -> None:
        if self._closed:
            return
        await self.accessor.close()
        await self._index.close()
        self._closed = True
