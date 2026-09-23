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
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.types import ReadPolicy
from mirage.utils.errors import OperationNotSupportedError
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

    The single reconcile point every read path shares. Under a mount's
    ``read: fresh`` a backend re-stat classifies a path as fresh, stale
    (fingerprint mismatch), gone (deletion), or unknown (no fingerprint
    to compare).
    One deletion signal feeds both consumers with separate reactions: the
    file cache evicts and the namespace GCs any orphaned attribute overlay.

    Three read paths call in: the cached-read gate (``may_serve_cached``),
    which the dispatcher and the file cache's own door both run, its main-op
    catch (``on_op_missing``) for cross-mount and programmatic reads, and the
    mount registry's per-command reconcile (``reconcile_read``) for
    single-mount shell reads. Reconcile state follows each consumer's store
    (RAM local, Redis shared across runtimes), so this is a thin coordinator
    holding references, not config.

    The gate and ``reconcile_read`` overlap deliberately: a warm named
    operand is probed once at routing and again at the gate. Deduplicating
    them needs a fact neither tier owns -- routing runs before any handler,
    the gate inside one -- so the cheap version was a flag on the command
    that went stale the moment a backend registered its own reader. Paying
    the second probe is the honest price until the two tiers share a scope.
    """

    def __init__(self, cache: FileCacheMixin, namespace: Namespace) -> None:
        self._cache = cache
        self._namespace = namespace

    async def _probe(self, mount: MountEntry, path: str) -> Verdict:
        """Re-stat the backend and apply the matching cache/overlay reaction.

        A missing path GCs (evict cache + drop overlay); a fingerprint
        mismatch evicts the stale cache entry. Non-404 errors propagate.

        Args:
            mount (MountEntry): the resolved mount for ``path``.
            path (str): absolute virtual path to probe.
        """
        # Resolve backend IDs without reusing cached metadata.
        try:
            remote_stat = await mount.execute_op("stat",
                                                 path,
                                                 index=RAMIndexCacheStore())
        except FileNotFoundError:
            await self.on_missing(path)
            await mount.index.clear()
            return Verdict.GONE
        except OperationNotSupportedError:
            # A backend that registers no stat op cannot be revalidated at
            # all. `_probe_or_unknown` would reach the same verdict, but it
            # would also log every read: this is a permanent capability of
            # the mount, not an anomaly worth a log line each time.
            await self._cache.remove(path)
            await mount.index.clear()
            return Verdict.UNKNOWN
        if remote_stat is None or remote_stat.fingerprint is None:
            await self._cache.remove(path)
            await mount.index.clear()
            return Verdict.UNKNOWN
        if not await self._cache.is_fresh(path, remote_stat.fingerprint):
            await self._cache.remove(path)
            await mount.index.clear()
            return Verdict.STALE
        return Verdict.FRESH

    async def _probe_or_unknown(self, mount: MountEntry, path: str) -> Verdict:
        """Probe, treating a failed probe as "cannot verify".

        A backend that cannot answer right now is the same situation as one
        that answers without a fingerprint: the copy cannot be verified, so
        it is dropped and the caller reads cold. Raising instead would be
        strictly worse -- it serves nothing and protects nothing further,
        and inside a recursive walk one transient stat would abort the whole
        traversal rather than the one file.

        Args:
            mount (MountEntry): the resolved mount for ``path``.
            path (str): absolute virtual path to probe.
        """
        try:
            return await self._probe(mount, path)
        except FileNotFoundError:
            raise
        except (TypeError, AttributeError, NameError):
            # A backend that cannot answer is one thing; a bug in the probe
            # path is another, and degrading it to "cannot verify" would
            # hide it behind a log line and a lifetime of cold reads.
            #
            # `RuntimeError` is deliberately absent, and this is the one
            # place it would be tempting: asyncio raises it for "Event loop
            # is closed" and "cannot reuse already awaited coroutine", both
            # reachable from a mount retiring under a walk. Re-raising it
            # would abort the traversal -- the failure this gate exists to
            # prevent -- and only on python, since JavaScript has no twin.
            # CLAUDE.md's rule is still met: it is not swallowed, it is
            # logged and turned into a verdict that drops the entry and
            # re-reads.
            raise
        except Exception as exc:
            await self._cache.remove(path)
            await mount.index.clear()
            logger.debug("probe failed for %s: %s", path, exc)
            return Verdict.UNKNOWN

    async def may_serve_cached(self, mount: MountEntry, path: str) -> bool:
        """Gate a cached read: is the cached copy still valid to serve?

        Under ``bounded`` the cache is trusted within its bound. Under
        ``fresh`` the backend is
        re-stated: a matching fingerprint serves the cached copy, a
        mismatch evicts it, a path the backend no longer has GCs and
        raises, and a backend that answers no fingerprint at all -- or no
        ``stat`` at all -- cannot be verified, so the copy is dropped and
        the caller re-reads.

        ``SUPPORTS_SNAPSHOT`` deliberately does not appear here. It used
        to short-circuit this function, dropping every cached copy on a
        resource that declares it False. That is a proxy for "the stat
        carries no content token", and it is the wrong one: box, dropbox,
        ssh and github all stamp a fingerprint without setting the flag,
        so the shortcut threw away entries this probe can verify. The
        backends that really cannot be checked are answered by
        ``_probe``'s own UNKNOWN arm, one stat later.

        Args:
            mount (MountEntry): the resolved mount for ``path``.
            path (str): absolute virtual path being read.

        Returns:
            bool: True when the cached bytes may be served.
        """
        if mount.read.policy is not ReadPolicy.FRESH:
            # Bounded: the store expires the entry on its own, except for
            # one population it cannot. Nothing stamped a ttl before this
            # policy existed, and `_set_cached_locked` short-circuits a
            # warm read rather than re-setting it, so a bound-less entry
            # would never acquire one and never expire. Removing it --
            # not merely declining to serve it -- is what makes the cold
            # read that follows stamp the bound; refusing alone would
            # leave the entry in place and refetch on every read forever.
            if await self._cache.is_unbounded(path):
                await self._cache.remove(path)
                return False
            return True
        verdict = await self._probe_or_unknown(mount, path)
        if verdict is Verdict.GONE:
            raise FileNotFoundError(path)
        return verdict is Verdict.FRESH

    async def reconcile_read(self, mount: MountEntry, path: str) -> None:
        """Reconcile a single-mount shell read before the command runs.

        ``cat``/``ls``/``stat`` on one mount resolve here (not through the
        dispatcher), so this is where their reads reconcile against backend
        truth. Only paths that carry an overlay or a cached copy are probed
        (a plain read pays nothing); a remote delete then evicts the cache
        AND GCs the orphaned overlay, and a stale entry is dropped.

        **Nothing escapes.** This runs during routing, before any handler
        exists, so an exception here does not fail one command -- it takes
        the whole line, later pipeline stages and `;` chains included, and
        reports itself with no operand to name. ``_probe_or_unknown`` still
        re-raises a programming error for the gate's benefit, which is
        correct there because the gate runs inside a handler; here that same
        raise is only a way to lose output. So the probe is best-effort: drop
        what could not be verified, log it, and let the command read the
        backend itself.

        Args:
            mount (MountEntry): the resolved mount for ``path``.
            path (str): absolute virtual path the command will read.
        """
        if mount.read.policy is not ReadPolicy.FRESH:
            return
        if (self._namespace.meta_for(path) is None
                and not await self._cache.exists(path)):
            return
        try:
            await self._probe_or_unknown(mount, path)
        except Exception as exc:
            await self._cache.remove(path)
            await mount.index.clear()
            logger.debug("reconcile probe failed for %s: %s", path, exc)

    async def on_op_missing(self, mount: MountEntry, op: str,
                            path: str) -> None:
        """React to a read/stat op that the backend reported gone.

        Keyed on the mount's policy rather than fired unconditionally,
        and that is deliberate. An ENOENT here is not proof the backend
        said so: object-store ``stat`` answers a miss straight out of a
        live index listing, and so do the box, gdrive, dropbox,
        hierarchy and hf_hub reads. Reacting to one of those would drop
        an attribute overlay -- which no backend stores, so nothing can
        put it back -- on the strength of cached negative knowledge.

        Widening this safely needs an index-sourced ENOENT that says so;
        until then a mount that declined to revalidate also declines to
        GC on a miss.

        Args:
            mount (MountEntry): the resolved mount for ``path``.
            op (str): the op that raised.
            path (str): absolute virtual path the backend reports gone.
        """
        if (mount.read.policy is ReadPolicy.FRESH and op in _REVALIDATE_OPS):
            await self.on_missing(path)

    async def on_missing(self, path: str) -> None:
        """Apply the deletion reaction: evict cache + GC orphaned overlay.

        An authoritative symlink node is left intact (drop_overlay skips it).

        Args:
            path (str): absolute virtual path the backend reports gone.
        """
        await self._cache.remove(path)
        await self._namespace.drop_overlay(path)
