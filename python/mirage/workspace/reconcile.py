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
from functools import partial

from mirage.cache.file.mixin import FileCacheMixin
from mirage.cache.index.config import Evicted
from mirage.cache.index.ram import ListingCheckStore
from mirage.errors.fs import enoent
from mirage.errors.types import OperationNotSupportedError
from mirage.types import (
    FileChangeKind,
    FileStat,
    FileType,
    ListingVersion,
    PathSpec,
    ReadPolicy,
)
from mirage.utils.path import ancestors
from mirage.vfs.base import BaseVFS
from mirage.vfs.call import call_names, declared_calls
from mirage.vfs.types import Effect, Target
from mirage.workspace.mount.mount import MountEntry
from mirage.workspace.mount.namespace import Namespace

logger = logging.getLogger(__name__)

_CALLS = declared_calls(BaseVFS)

# What a FRESH read policy revalidates: a file's content and a stat.
_REVALIDATE_OPS = call_names(
    _CALLS, effects={Effect.READ}, targets={Target.FILE}
) | call_names(_CALLS, effects={Effect.METADATA})


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

    Three read paths call in, all at the dispatcher: its cached-read gate
    (``may_serve_cached``), its main-op catch (``on_enoent``), and its
    first lookup of a path the running command's line names
    (``reconcile_read``). Reconcile state follows each consumer's store
    (RAM local, Redis shared across runtimes), so this is a thin
    coordinator holding references, not config.

    The gate and ``reconcile_read`` both run for a warm named operand, once
    at the command's first lookup of it and again at the gate, and they
    share one scope: the command. The first probe's backend answer is kept
    on the mount's ``CacheManager`` for the rest of the command, so the
    gate, and the command's own stat of the operand, reuse it instead of
    asking again. A
    write in the command, the clear after an external program, or a re-list
    that finds the path gone retires it, and a read outside any command (FUSE,
    the dispatcher) never sees it.
    """

    def __init__(self, cache: FileCacheMixin, namespace: Namespace) -> None:
        self._cache = cache
        self._namespace = namespace

    async def _drop(
        self, mount: MountEntry, path: str, keep: bool = False
    ) -> None:
        """Drop what the backend no longer vouches for at ``path`` as a
        remove drops it (``CacheManager.invalidate``), under this mount's
        name only: its body, its own listing, its row in its parent's and
        what is cached below a folder, not every listing the mount holds.

        Args:
            mount (MountEntry): the resolved mount for ``path``.
            path (str): absolute virtual path.
            keep (bool): the probe's backend answer still stands, so the
                command's own stat of ``path`` reuses it past the drop.
        """
        manager = mount.cache_manager
        if manager is None:
            await self._cache.remove(path)
            return
        spec = PathSpec.from_str_path(path)
        await manager.invalidate(
            spec,
            FileChangeKind.DELETE,
            probed=manager.probed_stat(spec) if keep else None,
        )

    async def _probe(self, mount: MountEntry, path: str) -> Verdict:
        """Re-stat the backend and apply the matching cache/overlay reaction.

        A missing path GCs (evict cache + drop overlay); a fingerprint
        mismatch evicts the stale cache entry. Non-404 errors propagate.

        Inside a command, what an earlier probe of the same command got
        from the backend is reused (``CacheManager.probed_stat``) until a
        write lands: the verdict and its reactions still run, only the
        round trip is skipped.

        Args:
            mount (MountEntry): the resolved mount for ``path``.
            path (str): absolute virtual path to probe.
        """
        manager = mount.cache_manager
        spec = PathSpec.from_str_path(path)
        remote_stat = None if manager is None else manager.probed_stat(spec)
        scratch = None
        generation = None if manager is None else manager.generation
        if remote_stat is None:
            scratch = ListingCheckStore(hints=mount.index)
            # No cached row answers; the mount's rows ride along as hints.
            try:
                remote_stat = await mount.call("stat", path, index=scratch)
            except (FileNotFoundError, NotADirectoryError):
                await self._drop(mount, path)
                await self._namespace.drop_overlay(path)
                return Verdict.GONE
            except OperationNotSupportedError:
                # A backend that registers no stat op cannot be revalidated
                # at all. `_probe_or_unknown` would reach the same verdict,
                # but it would also log every read: this is a permanent
                # capability of the mount, not an anomaly worth a log line
                # each time.
                await self._drop(mount, path)
                return Verdict.UNKNOWN
            if (
                manager is not None
                and manager.generation == generation
                and isinstance(remote_stat, FileStat)
            ):
                manager.note_probed(spec, remote_stat)
        if remote_stat is None or remote_stat.fingerprint is None:
            await self._drop(mount, path, keep=True)
            return Verdict.UNKNOWN
        if not await self._cache.is_fresh(path, remote_stat.fingerprint):
            await self._drop(mount, path, keep=True)
            return Verdict.STALE
        predecessor = (
            None if scratch is None else scratch.hinted_rows.get(path)
        )
        if (
            scratch is not None
            and predecessor is not None
            and manager is not None
            and generation is not None
        ):
            confirmed = (await scratch.get(path)).entry
            if confirmed is not None:
                await manager.retain_resolved_entry(
                    spec, generation, predecessor, confirmed
                )
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
        except (FileNotFoundError, NotADirectoryError):
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
            await self._drop(mount, path)
            logger.warning("probe failed for %s: %s", path, exc)
            return Verdict.UNKNOWN

    async def may_serve_cached(self, mount: MountEntry, path: str) -> bool:
        """Gate a cached read: is the cached copy still valid to serve?

        Under ``bounded`` the cache is trusted within its bound. Under
        ``fresh`` a backend probe (reused within its command until a write)
        supplies the fingerprint: a match serves the cached copy, a
        mismatch evicts it, a path the backend no longer has GCs and
        raises, and a backend that answers no fingerprint at all -- or no
        ``stat`` at all -- cannot be verified, so the copy is dropped and
        the caller re-reads.

        ``supports_snapshot`` deliberately does not appear here. It used
        to short-circuit this function, dropping every cached copy on a
        resource that declares it False. That is a proxy for "the stat
        carries no content token", and it is the wrong one: box, dropbox
        and ssh all stamp a fingerprint without setting the flag,
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
            raise enoent(path)
        return verdict is Verdict.FRESH

    async def may_serve_listing(
        self, mount: MountEntry, folder: str, version: str | None
    ) -> bool:
        """Gate a cached listing: may it be served without re-listing?

        Under ``bounded`` the listing is trusted within its bound. Under
        ``fresh`` a listing the running command fetched itself is served (a
        read outside any command trusts one fetched within the last
        ``LISTING_TRUST_WINDOW`` seconds instead,
        ``CacheManager.listing_trusted``). Past that, a listing stored at
        the mount's pin is served without asking: github pins a full-sha
        ref and serves its listing unchecked when the stored version equals
        that sha. It names a commit: github.com refuses a 40- or 64-hex
        branch or tag name, and a GitHub Enterprise host is assumed to as
        well (``github._pin_of``). A mount that declares a
        ``listing_version`` then has its stored ``version`` checked against
        a stat of the mount root (MOUNT) or of the folder (FOLDER), sent
        through a throwaway index so no cached row answers it. One check
        answers for a whole command, and concurrent callers share it
        (``CacheManager.checked_version``).

        A match serves the listing. Anything else answers EXPIRED and keeps
        the listing stored for the re-list to diff: a moved version, a path
        the backend no longer has, a stat with no fingerprint, a mount with
        no stat at all, and a backend that cannot answer, which is logged.
        The index is never cleared here. A programming error propagates.

        Args:
            mount (MountEntry): the mount holding the listing.
            folder (str): mount-absolute listing key.
            version (str | None): the version stored with the listing.

        Returns:
            bool: True when the cached listing may be served.
        """
        if mount.read.policy is not ReadPolicy.FRESH:
            return True
        manager = mount.cache_manager
        if manager is None:
            return False
        if manager.listing_trusted(folder):
            return True
        vfs = mount.vfs
        if vfs.listings_pin is not None and version == vfs.listings_pin:
            return True
        if vfs.listing_version == ListingVersion.NONE or version is None:
            return False
        key = (
            folder
            if vfs.listing_version == ListingVersion.FOLDER
            else mount.prefix.rstrip("/") or "/"
        )
        try:
            remote = await manager.checked_version(
                key, version, partial(self._listing_fingerprint, mount, key)
            )
        except (
            FileNotFoundError,
            NotADirectoryError,
            OperationNotSupportedError,
        ):
            return False
        except (TypeError, AttributeError, NameError):
            raise
        except Exception as exc:
            logger.debug("listing check failed for %s: %s", key, exc)
            return False
        return remote == version

    async def _listing_fingerprint(
        self, mount: MountEntry, path: str
    ) -> str | None:
        """Ask the backend for the version a listing check compares.

        Args:
            mount (MountEntry): the mount holding the listing.
            path (str): the mount root or the folder the version covers.
        """
        remote = await mount.call("stat", path, index=ListingCheckStore())
        return remote.fingerprint if isinstance(remote, FileStat) else None

    async def reconcile_read(self, mount: MountEntry, path: str) -> None:
        """Reconcile a path a command names before it answers the
        command's first lookup of it.

        The dispatcher calls this under ``read: fresh`` for a stat, listing
        or exists check of one of the line's own paths: a metadata command
        (``ls``, ``stat``) reads no bytes, so the cache gate never checks
        its operand. Only paths that carry an overlay or a cached copy are
        probed (a plain lookup pays nothing); a remote delete then evicts
        the cache AND GCs the orphaned overlay, and a stale entry is
        dropped.

        **Nothing escapes.** A lookup that cannot be verified must still be
        answered, so the probe is best-effort: drop what could not be
        verified, log it, and let the lookup ask the backend itself.

        Args:
            mount (MountEntry): the resolved mount for ``path``.
            path (str): absolute virtual path the command looks up.
        """
        if mount.read.policy is not ReadPolicy.FRESH:
            return
        if self._namespace.meta_for(
            path
        ) is None and not await self._cache.exists(path):
            return
        try:
            await self._probe_or_unknown(mount, path)
        except Exception as exc:
            await self._drop(mount, path)
            logger.warning("reconcile probe failed for %s: %s", path, exc)

    async def on_enoent(self, mount: MountEntry, name: str, path: str) -> None:
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
            name (str): the op that raised.
            path (str): absolute virtual path the backend reports gone.
        """
        if mount.read.policy is ReadPolicy.FRESH and name in _REVALIDATE_OPS:
            await self.on_missing(path)

    async def on_fresh_stat(
        self, mount: MountEntry, path: str, row: FileStat | None
    ) -> None:
        """Reconcile one path with what a fresh stat got from the backend.

        Through the mount's cache manager, so a read that began before the
        answer cannot stamp the cache after it. A path gone, or a listed
        folder now a file, is reported gone as a re-list's vanished child
        is: its bodies and overlays below go, nested mounts and links stay,
        and its listings are dropped. A row that disagrees with the stored
        one, or a held copy the fingerprint cannot vouch for, is
        invalidated as a write is, keeping the version a conditional write
        sends. A vouched copy whose row moved keeps its bytes. The
        dispatcher runs the stat and this under the path's writer hold, so
        no local write to the path lands between the answer and its
        reconcile.

        Args:
            mount (MountEntry): the mount that answered.
            path (str): absolute virtual path the stat asked about.
            row (FileStat | None): the backend's answer, None when it
                reported the path gone.
        """
        manager = mount.cache_manager
        if manager is None:
            return
        spec = PathSpec.from_str_path(path)
        stored = (await mount.index.get(path)).entry
        folder = (
            stored is not None and stored.type is FileType.DIRECTORY
        ) or await mount.index.holds_subtree(path)
        if row is None or (folder and row.type is not FileType.DIRECTORY):
            await mount.index.report_gone([Evicted(path, folder=folder)])
            await manager.invalidate(spec, FileChangeKind.DELETE)
            return
        held = await self._cache.exists(path)
        vouched = (
            held
            and row.fingerprint is not None
            and await self._cache.is_fresh(path, row.fingerprint)
        )
        same = (
            stored is not None
            and stored.model_copy(
                update={"name": row.name, "extra": row.extra}
            )
            == row
        )
        if same and (vouched or not held):
            return
        if vouched:
            await mount.index.invalidate_entry(path)
            return
        version = await manager.read_version(spec)
        await manager.invalidate(spec, FileChangeKind.UPDATE)
        if version is not None:
            await manager.keep_version(spec, version)

    async def on_gone(
        self, gone: list[Evicted], excluded: tuple[str, ...] = ()
    ) -> None:
        """Clean up the children a complete re-list removed or replaced.

        Args:
            gone (list[Evicted]): vanished children and replaced folders.
            excluded (tuple[str, ...]): nested mount roots to preserve.
        """
        paths = dict.fromkeys(child.path.rstrip("/") or "/" for child in gone)
        folders = {
            child.path.rstrip("/") or "/" for child in gone if child.folder
        }
        for path in paths:
            parents = ancestors(path) + (["/"] if path != "/" else [])
            if folders.isdisjoint(parents):
                await self._cache.remove(
                    path, subtree=path in folders, excluded=excluded
                )
        if paths:
            await self._namespace.drop_overlays_under(
                list(paths), excluded=excluded
            )

    async def on_missing(self, path: str) -> None:
        """Apply the deletion reaction: evict cache + GC orphaned overlay.

        An authoritative symlink node is left intact (drop_overlay skips it).

        Args:
            path (str): absolute virtual path the backend reports gone.
        """
        await self._cache.remove(path)
        await self._namespace.drop_overlay(path)
