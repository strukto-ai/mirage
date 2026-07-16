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

import logging
from enum import Enum

from mirage.cache.file.mixin import FileCacheMixin
from mirage.types import ConsistencyPolicy
from mirage.workspace.mount.mount import MountEntry
from mirage.workspace.mount.namespace import Namespace

logger = logging.getLogger(__name__)

_REVALIDATE_OPS = frozenset({"read", "read_bytes", "stat"})


class Verdict(Enum):
    FRESH = "fresh"
    STALE = "stale"
    GONE = "gone"
    UNKNOWN = "unknown"


class Reconciler:
    """Keep the local view honest against backend truth.

    The single reconcile point every read path shares. Under ALWAYS a
    backend re-stat classifies a path as fresh, stale (fingerprint
    mismatch), gone (deletion), or unknown (no fingerprint to compare).
    One deletion signal feeds both consumers with separate reactions: the
    file cache evicts and the namespace GCs any orphaned attribute overlay.

    Three read paths call in: the dispatcher's cached-read gate
    (``may_serve_cached``) and its main-op catch (``on_op_missing``) for
    cross-mount and programmatic reads, and the mount registry's per-command
    reconcile (``reconcile_read``) for single-mount shell reads. Reconcile
    state follows each consumer's store (RAM local, Redis shared across
    runtimes), so this is a thin coordinator holding references, not config.
    """

    def __init__(self, cache: FileCacheMixin, namespace: Namespace,
                 consistency: ConsistencyPolicy) -> None:
        self._cache = cache
        self._namespace = namespace
        self._consistency = consistency

    async def _probe(self, mount: MountEntry, path: str) -> Verdict:
        """Re-stat the backend and apply the matching cache/overlay reaction.

        A missing path GCs (evict cache + drop overlay); a fingerprint
        mismatch evicts the stale cache entry. Non-404 errors propagate.

        Args:
            mount (MountEntry): the resolved mount for ``path``.
            path (str): absolute virtual path to probe.
        """
        try:
            remote_stat = await mount.execute_op("stat", path)
        except FileNotFoundError:
            await self.on_missing(path)
            return Verdict.GONE
        if remote_stat is None or remote_stat.fingerprint is None:
            return Verdict.UNKNOWN
        if not await self._cache.is_fresh(path, remote_stat.fingerprint):
            await self._cache.remove(path)
            return Verdict.STALE
        return Verdict.FRESH

    async def may_serve_cached(self, mount: MountEntry, path: str) -> bool:
        """Gate a cached read: is the cached copy still valid to serve?

        Under LAZY the cache is trusted. Under ALWAYS: a backend that carries
        a fingerprint is re-stated and served only when fresh (a mismatch
        evicts, a missing path GCs and re-raises); a backend with no
        fingerprint cannot be cheaply verified, so the cached copy is dropped
        and the caller re-reads (the fresh read also surfaces a remote delete
        via its own FileNotFoundError, feeding on_op_missing).

        Args:
            mount (MountEntry): the resolved mount for ``path``.
            path (str): absolute virtual path being read.

        Returns:
            bool: True when the cached bytes may be served.
        """
        if self._consistency != ConsistencyPolicy.ALWAYS:
            return True
        if not mount.resource.SUPPORTS_SNAPSHOT:
            await self._cache.remove(path)
            return False
        verdict = await self._probe(mount, path)
        if verdict is Verdict.GONE:
            raise FileNotFoundError(path)
        return verdict is not Verdict.STALE

    async def reconcile_read(self, mount: MountEntry, path: str) -> None:
        """Reconcile a single-mount shell read before the command runs.

        ``cat``/``ls``/``stat`` on one mount resolve here (not through the
        dispatcher), so this is where their reads reconcile against backend
        truth. Only paths that carry an overlay or a cached copy are probed
        (a plain read pays nothing); a remote delete then evicts the cache
        AND GCs the orphaned overlay, and a stale entry is dropped.
        Best-effort: a transient probe error is logged and swallowed so the
        command still runs (it reads the backend directly and fails on its
        own if the path is truly gone).

        Args:
            mount (MountEntry): the resolved mount for ``path``.
            path (str): absolute virtual path the command will read.
        """
        if self._consistency != ConsistencyPolicy.ALWAYS:
            return
        if (self._namespace.meta_for(path) is None
                and not await self._cache.exists(path)):
            return
        try:
            await self._probe(mount, path)
        except Exception as exc:
            logger.debug("reconcile_read probe failed for %s: %s", path, exc)

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
