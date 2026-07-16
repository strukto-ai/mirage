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

from mirage.cache.file.mixin import FileCacheMixin
from mirage.types import ConsistencyPolicy
from mirage.workspace.mount.mount import MountEntry
from mirage.workspace.mount.namespace import Namespace

_REVALIDATE_OPS = frozenset({"read", "read_bytes", "stat"})


class Reconciler:
    """Keep the local view honest against backend truth.

    Owns the single reconcile concern the dispatcher used to smear across
    its hot path: under ALWAYS consistency, a re-stat detects when a cached
    entry is stale (fingerprint mismatch) or gone (deletion). One deletion
    signal feeds both consumers with separate reactions: the file cache
    evicts and the namespace GCs any orphaned attribute overlay. Reconcile
    state follows each consumer's store (RAM local, Redis shared across
    runtimes), so this is a thin coordinator holding references, not config.
    """

    def __init__(self, cache: FileCacheMixin, namespace: Namespace,
                 consistency: ConsistencyPolicy) -> None:
        self._cache = cache
        self._namespace = namespace
        self._consistency = consistency

    async def may_serve_cached(self, mount: MountEntry, path: str) -> bool:
        """Gate a cached read: is the cached copy still valid to serve?

        Under LAZY the cache is trusted. Under ALWAYS the backend is
        re-stated: a fingerprint mismatch evicts (return False, fall back to
        a real read); a missing path GCs and re-raises.

        Args:
            mount (MountEntry): the resolved mount for ``path``.
            path (str): absolute virtual path being read.

        Returns:
            bool: True when the cached bytes may be served.
        """
        if self._consistency != ConsistencyPolicy.ALWAYS:
            return True
        try:
            remote_stat = await mount.execute_op("stat", path)
        except FileNotFoundError:
            await self.on_missing(path)
            raise
        if remote_stat is not None and remote_stat.fingerprint is not None:
            if not await self._cache.is_fresh(path, remote_stat.fingerprint):
                await self._cache.remove(path)
                return False
        return True

    async def on_op_missing(self, op: str, path: str) -> None:
        """React to a read/stat op that the backend reported gone.

        Args:
            op (str): the op that raised.
            path (str): absolute virtual path the backend reports gone.
        """
        if (self._consistency == ConsistencyPolicy.ALWAYS
                and op in _REVALIDATE_OPS):
            await self.on_missing(path)

    async def on_missing(self, path: str) -> None:
        """Apply the deletion reaction: evict cache + GC orphaned overlay.

        An authoritative symlink node is left intact (drop_overlay skips it).

        Args:
            path (str): absolute virtual path the backend reports gone.
        """
        await self._cache.remove(path)
        await self._namespace.drop_overlay(path)
