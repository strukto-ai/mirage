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

from mirage.accessor.base import Accessor
from mirage.cache.index import (IndexCacheStore, IndexConfig,
                                RAMIndexCacheStore, RedisIndexConfig)
from mirage.types import Revision

try:
    from mirage.cache.index import RedisIndexCacheStore
except ImportError:
    RedisIndexCacheStore = None  # type: ignore[misc, assignment]


class BaseResource:

    name: str = "base"
    is_remote: bool = False
    accessor: Accessor = Accessor()
    _ops: dict[str, Callable[..., Any]] = {}
    PROMPT: str = ""
    WRITE_PROMPT: str = ""

    _index_ttl: float = 600

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
        **kwargs,
    ) -> None:
        super().__init__(**kwargs)
        self._commands: list = []
        self._ops_list: list = []
        cfg = index or IndexConfig(ttl=self._index_ttl)
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

    async def resolve_glob(self, paths: list, prefix: str = "") -> list[str]:
        raise NotImplementedError

    def __getattr__(self, name: str) -> Any:
        fn = type(self)._ops.get(name)
        if fn is not None:
            return partial(fn, self.accessor)
        raise AttributeError(
            f"'{type(self).__name__}' has no attribute '{name}'")

    async def fingerprint(self, path: str) -> str | None:
        """Return current remote fingerprint for freshness comparison.

        Args:
            path (str): Backend-relative path.

        Returns:
            str | None: Fingerprint string, or None if always fresh.
        """
        return None

    def pin_revision(self, path: str, revision: Revision) -> bool:
        """Pin future reads at `path` to a specific revision.

        Snapshot+replay hook. When the snapshot manifest carries a
        ``revision`` for a recorded read, ``Workspace.load`` calls this
        on the owning resource to install the pin. Subsequent reads at
        that path then fetch the exact recorded version (e.g. S3
        ``GetObject(VersionId=...)``) instead of the current head, and
        the drift check skips the path because the bytes are guaranteed
        to match by construction.

        Default returns False: the backend does not support revision
        pinning, so the load layer will fall back to drift detection
        only. Override in subclasses that can honor a pin (S3 family
        today; Google Drive, GitHub, Azure Blob in the future).

        Args:
            path (str): Virtual path whose reads should be pinned.
            revision (Revision): Opaque per-backend revision marker
                that was captured at snapshot time.

        Returns:
            bool: True if the pin was accepted and future reads will
            honor it; False if the backend does not pin (caller falls
            back to drift detection).
        """
        return False

    def register_op(self, fn) -> None:
        for ro in fn._registered_ops:
            self._ops_list.append(ro)

    def ops_list(self) -> list:
        return self._ops_list

    def register(self, fn) -> None:
        for rc in fn._registered_commands:
            self._commands.append(rc)

    def commands(self) -> list:
        return self._commands

    def get_state(self) -> dict:
        return {
            "type": self.name,
            "needs_override": False,
            "redacted_fields": [],
        }

    def load_state(self, state: dict) -> None:
        pass
