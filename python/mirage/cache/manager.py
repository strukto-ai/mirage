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

import asyncio
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import TypeVar

from mirage.cache.context import capture_read
from mirage.cache.file.io import latest_fingerprint, mutation_lock
from mirage.cache.file.mixin import FileCacheMixin
from mirage.cache.index.config import Evicted, IndexEntry
from mirage.cache.index.constants import (
    CHECKED_LIMIT,
    LISTING_TRUST_WINDOW,
    PROBED_LIMIT,
)
from mirage.cache.index.scope import command_started, tick
from mirage.cache.index.store import IndexCacheStore
from mirage.cache.index.view import IndexView
from mirage.io.stream import close_quietly
from mirage.observe.context import active_recorder, line_version
from mirage.observe.record import OpRecord
from mirage.types import DEFAULT_READ_TTL, FileStat, PathSpec
from mirage.utils.key_prefix import mount_key

logger = logging.getLogger(__name__)

T = TypeVar("T")


def _now() -> float:
    """Monotonic seconds, read through one name so tests can move it."""
    return time.monotonic()


class CacheManager:
    """Post-mutation cache coherence for one mount.

    A backend mutation has two cache consequences: the file-cache entry
    for the path is stale, and the parent directory listing in the
    index cache (including negative knowledge that the path does not
    exist) is stale. This class discharges both, synchronously, at the
    mutation site: core backend mutators report through
    ``mirage.cache.context`` right where they already emit observe
    records, so invalidation happens before the next command in a
    pipeline runs instead of after the whole command tree.
    """

    def __init__(
        self,
        file_cache: FileCacheMixin | None,
        index: IndexCacheStore,
        prefix: str,
        caches_reads: bool,
        owns_path: Callable[[str], bool] = lambda _: True,
        read_ttl: int = DEFAULT_READ_TTL,
        on_gone: Callable[[list[Evicted]], Awaitable[None]] | None = None,
        may_serve_listing: Callable[[str, str | None], Awaitable[bool]]
        | None = None,
        excluded_prefixes: Callable[[], tuple[str, ...]] = tuple,
    ) -> None:
        """Args:
        file_cache (FileCacheMixin | None): Workspace file cache
            store; entries are keyed by mount-absolute path.
        index (IndexCacheStore): The mount VFS's index cache;
            listings are keyed by mount-absolute path, which every
            backend agrees on.
        prefix (str): Mount prefix (e.g. "/data/").
        caches_reads (bool): Whether the VFS caches reads; the
            file cache only holds paths for read-caching backends.
        owns_path (Callable[[str], bool]): whether this mount still
            owns a virtual cache key.
        read_ttl (int): lifetime of complete backend renders, and the
            cap on every listing this mount's view writes.
        on_gone (Callable[[list[Evicted]], Awaitable[None]] | None):
            cleanup for children a re-list found gone, injected because
            this class holds no mount and no dispatcher; None cleans
            nothing.
        may_serve_listing (Callable[[str, str | None], Awaitable[bool]]
            | None): the listing gate every view of this mount asks,
            with the folder and its stored version, before serving a
            cached listing; None serves them all.
        excluded_prefixes (Callable[[], tuple[str, ...]]): live nested
            mount roots protected from recursive deletion.
        """
        self._file_cache = file_cache
        self._index = index
        self._prefix = prefix.rstrip("/")
        self._caches_reads = caches_reads
        self._owns_path = owns_path
        self._read_ttl = read_ttl
        self._on_gone = on_gone
        self._excluded_prefixes = excluded_prefixes
        self._may_serve_listing = may_serve_listing
        self._written: dict[str, tuple[int, float]] = {}
        self._checked: dict[str, tuple[str, int, float]] = {}
        self._checking: dict[
            str, tuple[int, float, asyncio.Task[str | None]]
        ] = {}
        self._check_epoch = 0
        self._check_bound = CHECKED_LIMIT
        self._probed: dict[str, tuple[int, int, FileStat]] = {}
        self._probe_bound = PROBED_LIMIT
        self._read_generation = 0
        self._view: IndexView | None = None

    @asynccontextmanager
    async def mutation(self) -> AsyncIterator[None]:
        """Drain raw backend index access before mount cache eviction."""
        if self._file_cache is None:
            yield
            return
        async with mutation_lock(self._file_cache):
            yield

    async def clear_index(self, index: IndexCacheStore) -> None:
        """Clear the whole backend index while this mount still owns it.

        The clear that follows native code (an external program, a remote
        runtime line) that may have changed the mount, so it also retires
        what the running command's probes saw.
        """
        async with self.mutation():
            self._retire()
            if self._owns_path(self._prefix or "/"):
                await index.clear()

    def scope_index(self, index: IndexCacheStore) -> IndexCacheStore:
        """Bind backend metadata writes to this mount's lifetime.

        Reuse the view because refill locks are keyed by index identity.

        Args:
            index (IndexCacheStore): the VFS's own index.
        """
        if self._file_cache is None or isinstance(index, IndexView):
            return index
        if self._view is None or self._view.store is not index:
            self._written.clear()
            if self._view is not None:
                self._forget_checks()
            self._view = IndexView(
                index,
                self._file_cache,
                self._prefix,
                self._owns_path,
                read_ttl=self._read_ttl,
                on_gone=self._cleanup,
                excluded_prefixes=self._excluded_prefixes,
                may_serve_listing=self._may_serve_listing,
                note_written=self._note_written,
            )
        return self._view

    async def _cleanup(self, gone: list[Evicted]) -> None:
        async with self.mutation():
            await self._gone_locked(
                [child for child in gone if self._owns_path(child.path)]
            )

    async def _gone_locked(self, gone: list[Evicted]) -> None:
        if not gone:
            return
        # A re-list found children gone: the backend changed under the
        # command, so nothing its probes saw is safe to serve.
        self._retire()
        if self._on_gone is not None:
            await self._on_gone(gone)

    def _retire(self) -> None:
        """Retire every in-flight read and every remembered probe answer.

        The one step every cache drop takes: a read that began before it
        must not stamp the cache after it, and a probe answer from before
        it must not be served after it.
        """
        self._read_generation += 1
        self._probed.clear()
        self._probe_bound = PROBED_LIMIT

    def _note_written(self, folder: str) -> None:
        self._written[folder] = (tick(), _now())

    def listing_trusted(self, folder: str) -> bool:
        """Whether ``folder``'s listing is recent enough to serve under fresh.

        Inside a command: only if the command wrote it itself, so one
        command re-lists a folder once however often it reads it. Outside
        any command (FUSE, a programmatic op) there is no command to
        belong to, so a listing written within ``LISTING_TRUST_WINDOW``
        seconds is trusted instead: one ``ls -l`` over FUSE is a burst of
        calls that can share a re-list until the window expires.

        Every view of the mount, shared or lock-held, records into one map,
        so a glob's write counts for the ``ls`` that follows it.

        Args:
            folder (str): mount-absolute listing key.
        """
        written = self._written.get(folder)
        if written is None:
            return False
        stamp, at = written
        started = command_started()
        if started is not None:
            return stamp > started
        return _now() - at < LISTING_TRUST_WINDOW

    def _prune_checks(self) -> None:
        # A check answers only a caller inside its window, so the rest are
        # dead weight; the next prune waits for the map to double.
        self._checked = {
            key: checked
            for key, checked in self._checked.items()
            if self._sent_recently(checked[1], checked[2])
        }
        self._check_bound = max(CHECKED_LIMIT, 2 * len(self._checked))

    def _forget_checks(self) -> None:
        # The versions were checked against listings of the old store, so
        # none of them says anything about the new one. The first view has
        # no old store, and a check may be what builds it.
        self._checked.clear()
        self._checking.clear()
        self._check_epoch += 1

    @staticmethod
    def _sent_recently(sent_tick: int, sent_at: float) -> bool:
        """Whether a version check is recent enough to answer for the caller.

        The rule ``listing_trusted`` applies to listings: inside a command,
        only a check sent after the command started, since one sent before
        may predate a change the command must see; outside any command, one
        sent within ``LISTING_TRUST_WINDOW`` seconds.

        Args:
            sent_tick (int): the tick taken just before the check was sent.
            sent_at (float): the monotonic second it was sent at.
        """
        started = command_started()
        if started is not None:
            return sent_tick > started
        return _now() - sent_at < LISTING_TRUST_WINDOW

    async def checked_version(
        self, key: str, stored: str, check: Callable[[], Awaitable[str | None]]
    ) -> str | None:
        """The backend's listing version for ``key``, asking at most once.

        A check recent enough for the caller (``_sent_recently``) that
        answered ``stored`` is reused, so one command checks a mount once
        however many of its folders it lists. Otherwise a check in flight
        that is recent enough is shared, and only then is a new one sent;
        the newest in flight is the one later callers find. A remembered
        answer that differs from ``stored`` is asked again rather than
        trusted, since the listing may have been written since. The shared
        check is shielded, so one caller's cancellation never reaches the
        others.

        Args:
            key (str): what the version covers: the mount root, or a folder.
            stored (str): the version stored with the caller's listing.
            check (Callable[[], Awaitable[str | None]]): asks the backend;
                None when it answers no version.
        """
        checked = self._checked.get(key)
        if (
            checked is not None
            and checked[0] == stored
            and self._sent_recently(checked[1], checked[2])
        ):
            return checked[0]
        flight = self._checking.get(key)
        if flight is None or not self._sent_recently(flight[0], flight[1]):
            flight = self._send_check(key, check)
        return await asyncio.shield(flight[2])

    def _send_check(
        self, key: str, check: Callable[[], Awaitable[str | None]]
    ) -> tuple[int, float, asyncio.Task[str | None]]:
        sent_tick = tick()
        sent_at = _now()
        epoch = self._check_epoch

        async def run() -> str | None:
            version = await check()
            checked = self._checked.get(key)
            # Recorded here rather than by a waiter, so the answer lands
            # even when every waiter was cancelled; an older check that
            # lands late never replaces a newer one.
            if (
                version is not None
                and epoch == self._check_epoch
                and (checked is None or checked[1] < sent_tick)
            ):
                if checked is None and len(self._checked) >= self._check_bound:
                    self._prune_checks()
                self._checked[key] = (version, sent_tick, sent_at)
            return version

        def finished(completed: asyncio.Task[str | None]) -> None:
            flight = self._checking.get(key)
            if flight is not None and flight[2] is completed:
                self._checking.pop(key, None)
            # Retrieve failures even if every waiter was cancelled.
            if not completed.cancelled():
                completed.exception()

        task = asyncio.create_task(run())
        flight = (sent_tick, sent_at, task)
        self._checking[key] = flight
        task.add_done_callback(finished)
        return flight

    @property
    def generation(self) -> int:
        """Mutation generation, captured before a freshness probe starts."""
        return self._read_generation

    def note_probed(self, path: PathSpec, stat: FileStat) -> None:
        """Remember what the freshness probe got from the backend for ``path``.

        Only the reconciler's probe calls this, and only with an answer it
        got from the backend, so a stat served from an index row -- which
        may carry no content token -- never lands here. A path the backend
        reports gone records nothing: the probe asks the backend only when
        no answer is servable, so there is nothing left to take back.

        Args:
            path (PathSpec): the probed path; only ``virtual`` is read.
            stat (FileStat): the backend's answer.
        """
        started = command_started()
        if started is None:
            return
        if len(self._probed) >= self._probe_bound:
            self._prune_probes(started)
            # What is left is all the running command's; the next prune
            # waits for the map to double, so one large walk stays linear.
            self._probe_bound = max(PROBED_LIMIT, 2 * len(self._probed))
        self._probed[self._cache_key(path)] = (
            started,
            self._read_generation,
            stat,
        )

    def _prune_probes(self, started: int) -> None:
        # Only the probing command is ever served an answer, so the other
        # commands' entries are dead weight here.
        self._probed = {
            key: probed
            for key, probed in self._probed.items()
            if probed[0] == started
        }

    def probed_stat(self, path: PathSpec) -> FileStat | None:
        """The backend's answer for ``path`` from this command's probe.

        A read command stats its own operand after the probe already asked
        the backend; under fresh, asking again resolves through listings the
        command has not re-checked, and re-lists every folder on the path.
        The answer is served only inside the command that probed, and only
        while no cache drop has landed since: a write in the command
        (``sed -i``, ``> f``), the clear after an external program, and a
        re-list that found the path gone all retire it (``_retire``), so the
        next stat goes back to the backend.

        Args:
            path (PathSpec): the path to look up; only ``virtual`` is read.
        """
        probed = self._probed.get(self._cache_key(path))
        started = command_started()
        if probed is None or started is None:
            return None
        stamp, generation, stat = probed
        if stamp != started or generation != self._read_generation:
            return None
        return stat

    async def retain_resolved_entry(
        self,
        path: PathSpec,
        generation: int,
        predecessor: str,
        entry: IndexEntry,
    ) -> None:
        """Retain a live fallback row only while its predecessor still owns the slot.

        Args:
            path (PathSpec): confirmed file path.
            generation (int): generation before the remote check.
            predecessor (str): serialized previous index row.
            entry (IndexEntry): confirmed replacement row.
        """
        key = self._cache_key(path)
        async with self.mutation():
            if generation != self._read_generation or not self._owns_path(key):
                return
            await self.scope_index_locked(self._index).replace_if_unchanged(
                key, predecessor, entry
            )

    def scope_index_locked(self, index: IndexCacheStore) -> IndexCacheStore:
        """A view for a caller already inside ``mutation()``.

        Never share or retain it beyond that hold. A distinct refill lock
        avoids lock inversion with readers of the shared view.

        Args:
            index (IndexCacheStore): the VFS's own index, never a view.

        Raises:
            ValueError: ``index`` is already a view, which would take the
                lock again.
        """
        if self._file_cache is None:
            return index
        if isinstance(index, IndexView):
            raise ValueError(
                "scope_index_locked needs a raw store; a view "
                "would take the lock again"
            )
        return IndexView(
            index,
            self._file_cache,
            self._prefix,
            self._owns_path,
            locked=True,
            read_ttl=self._read_ttl,
            on_gone=self._gone_locked,
            excluded_prefixes=self._excluded_prefixes,
            may_serve_listing=self._may_serve_listing,
            note_written=self._note_written,
        )

    async def _evict_dir(self, key: str) -> None:
        """Drop one directory's cached listing.

        Both spellings of the directory go, because a backend may have
        keyed it with or without its trailing slash and an eviction that
        hits no key is silent.

        Args:
            key (str): Cache key of the directory (mount-absolute).
        """
        await self._index.invalidate_dir(key)
        await self._index.invalidate_dir(key + "/")

    def _cache_key(self, path: PathSpec) -> str:
        """Cache key for a path, derived rather than inferred.

        Both caches this class evicts from are keyed by the
        mount-absolute virtual path, so that is what this returns: the
        mount prefix still attached, not the mount-relative spelling
        ``mount_key`` produces on the way there.

        Only ``virtual`` is read, and the key is rebuilt against this
        manager's own prefix, exactly as ``Mount.call`` rebuilds
        one before handing a path to a backend. The caller's
        ``vfs_path`` is deliberately ignored: it is not a fact
        this class can trust, because ``PathSpec.from_str_path``
        fabricates one ("assumed root-mounted") for any caller that
        does not know its mount, and ~50 sites take that default.

        The earlier version inferred which convention had arrived by
        comparing the two strings, which cannot be done: under a ``/d``
        mount a mount-relative ``/d`` and an absolute ``/d`` are the
        same characters naming different files. Inferring wrong is
        quiet rather than loud -- a key one level off simply evicts
        nothing -- which is why it survived. Deriving asks no question
        that has no answer.

        Args:
            path (PathSpec): Path to key; only ``virtual`` is read.
        """
        key = mount_key(path.virtual, self._prefix)
        return f"{self._prefix}/{key}" if key else self._prefix or "/"

    def _readable_cache(self, key: str) -> FileCacheMixin | None:
        """The file cache this manager may read ``key`` from, if any.

        Args:
            key (str): Mount-absolute cache key.
        """
        if not self._caches_reads or not self._owns_path(key):
            return None
        return self._file_cache

    async def keep_version(self, path: PathSpec, version: str) -> None:
        """Keep ``version`` for ``path`` without bytes, if this mount caches.

        A refused write keeps the version it lost on, so the next write
        without a read sends it again. A cache that refuses the entry is
        logged, never raised: the refusal itself already stands.

        Args:
            path (PathSpec): the path refused.
            version (str): the version the write lost on.
        """
        key = self._cache_key(path)
        if self._file_cache is None or not self._owns_path(key):
            return
        try:
            async with mutation_lock(self._file_cache):
                await self._file_cache.keep_fingerprints({key: version})
        except Exception:
            logger.warning("version not kept for %s", key, exc_info=True)

    async def read_version(self, path: PathSpec) -> str | None:
        """The version this mount last saw for ``path``, None when none.

        The running line's own records come first, newest first: a read or
        write earlier in the line names the exact bytes it saw, and a
        streamed read is not in the cache until the line ends. Then the
        cached copy's backend token.

        Args:
            path (PathSpec): the path written.
        """
        return (await self.read_versions([path]))[0]

    async def read_versions(self, paths: list[PathSpec]) -> list[str | None]:
        """``read_version`` for many paths, asking the cache once.

        Args:
            paths (list[PathSpec]): the paths asked about.
        """
        out: list[str | None] = [None] * len(paths)
        pending: list[tuple[int, str]] = []
        recorder = active_recorder()
        for i, path in enumerate(paths):
            key = self._cache_key(path)
            if recorder is not None:
                known, version = line_version(
                    recorder.index, recorder.lost, key
                )
                if known:
                    out[i] = version
                    continue
            if self._file_cache is not None and self._owns_path(key):
                pending.append((i, key))
        if pending and self._file_cache is not None:
            tokens = await self._file_cache.fingerprints(
                [key for _, key in pending]
            )
            for (i, _), token in zip(pending, tokens):
                out[i] = token
        return out

    async def fill(
        self,
        path: PathSpec,
        fetch: Callable[[], Awaitable[T]],
        keep: Callable[[], bool] | None = None,
    ) -> T:
        """Run a cold whole-file read and keep its bytes for the next one.

        For the dispatcher, which probed the cache itself. A write that
        lands while the fetch runs retires the generation, so the bytes it
        read are not kept; an answer that is not bytes is returned and
        kept nowhere.
        ``keep``, when given, is asked after the fetch with the cache's
        mutation lock held and has the last say over whether the bytes
        are kept; the dispatcher passes "no renderer resolves for the
        read". It must be synchronous.

        Args:
            path (PathSpec): file being read.
            fetch (Callable): cold whole-file reader.
            keep (Callable[[], bool] | None): whether the bytes may still
                be kept once fetched; None keeps them.
        """
        generation = self._read_generation
        recorder = active_recorder()
        start = len(recorder.sink) if recorder is not None else 0
        key = self._cache_key(path)
        data, facts = await capture_read(key, fetch)
        if not isinstance(data, bytes):
            return data
        cache = self._readable_cache(key)
        if cache is not None:

            def token() -> str | None:
                if facts:
                    same = all(fp == facts[0] for fp in facts)
                    return facts[0] if same else None
                records = (
                    recorder.sink[start:] if recorder is not None else None
                )
                return latest_fingerprint(records, key)

            await self._keep_read(cache, key, data, generation, keep, token)
        return data

    def fill_stream(
        self,
        path: PathSpec,
        source: AsyncIterator[bytes],
        records: list[OpRecord],
        keep: Callable[[], bool] | None = None,
    ) -> AsyncIterator[bytes]:
        """Pass a cold streamed read through and keep its bytes for the next.

        The streamed twin of ``fill``: the bytes are kept once the last
        chunk is pulled, under the same rules (a write that lands while
        the stream runs retires the generation, and ``keep`` has the last
        say), labelled with the token this stream's backend recorded. A
        stream closed early, or larger than the cache's drain budget,
        keeps nothing, so the cache never reads past what the caller
        pulled and never holds more than it could.

        Args:
            path (PathSpec): file being read.
            source (AsyncIterator[bytes]): the cold stream.
            records (list[OpRecord]): what this stream's backend records.
            keep (Callable[[], bool] | None): whether the bytes may still
                be kept once read; None keeps them.
        """
        key = self._cache_key(path)
        cache = self._readable_cache(key)
        if cache is None:
            return source
        return self._filling(cache, key, source, records, keep)

    async def _filling(
        self,
        cache: FileCacheMixin,
        key: str,
        source: AsyncIterator[bytes],
        records: list[OpRecord],
        keep: Callable[[], bool] | None,
    ) -> AsyncIterator[bytes]:
        generation = self._read_generation
        budget = cache.drain_budget
        chunks: list[bytes] | None = []
        size = 0
        try:
            async for chunk in source:
                if chunks is not None:
                    size += len(chunk)
                    chunks = chunks if size <= budget else None
                    if chunks is not None:
                        chunks.append(chunk)
                yield chunk
        finally:
            await close_quietly(source)
        if chunks is not None:
            await self._keep_read(
                cache,
                key,
                b"".join(chunks),
                generation,
                keep,
                lambda: latest_fingerprint(records, key),
            )

    async def _keep_read(
        self,
        cache: FileCacheMixin,
        key: str,
        data: bytes,
        generation: int,
        keep: Callable[[], bool] | None,
        token: Callable[[], str | None],
    ) -> None:
        """Store a cold read's bytes unless something since made them stale.

        Args:
            cache (FileCacheMixin): the cache to fill.
            key (str): the path's cache key.
            data (bytes): the bytes read.
            generation (int): the read generation the read began in.
            keep (Callable[[], bool] | None): the last say on keeping.
            token (Callable[[], str | None]): the token labelling them.
        """
        if len(data) > cache.cache_limit:
            return
        async with mutation_lock(cache):
            if (
                self._owns_path(key)
                and generation == self._read_generation
                and (keep is None or keep())
            ):
                try:
                    await cache.set(
                        key, data, fingerprint=token(), ttl=self._read_ttl
                    )
                except Exception:
                    logger.warning(
                        "cache fill refused for %s", key, exc_info=True
                    )

    async def cached_size(self, path: PathSpec) -> int | None:
        """Return the cached render's byte length, without revalidating.

        The size backfill a render-dependent backend cannot answer for
        itself (``generic_bind.factory``) runs only where the backend
        reported no size, which is exactly the API mounts, so gating it
        would turn a stat into a backend stat. It answers a length rather
        than content, so nothing can serve unverified bytes through it.

        Args:
            path (PathSpec): the path to look up.
        """
        key = self._cache_key(path)
        cache = self._readable_cache(key)
        if cache is None:
            return None
        cached = await cache.get(key)
        return None if cached is None else len(cached)

    async def invalidate_after_write(self, path: PathSpec) -> None:
        """Invalidate caches after a write to ``path``.

        Args:
            path (PathSpec): Path that was written; only ``virtual`` is
                read.
        """
        key = await self._invalidate_path(path)
        await self._invalidate_parent(key)

    async def invalidate_after_unlink(self, path: PathSpec) -> None:
        """Invalidate caches after a deletion of ``path``.

        Args:
            path (PathSpec): Path that was removed; only ``virtual`` is
                read.
        """
        key = await self._invalidate_path(path)
        await self._invalidate_removed(key)

    async def invalidate_subtree(self, path: PathSpec) -> None:
        """Drop ``path`` and everything cached beneath it.

        Two callers, one shape. A push notification often says only
        which folder moved, and a recursive delete or a directory
        rename takes a whole tree with it; either way the listings and
        bodies below the path were cached independently, so evicting
        the path and its parent leaves stale entries one level down.
        The cheaper ``invalidate_after_write`` cannot be widened to do
        this, because it also runs on every ordinary write, where a
        file has no subtree to drop.

        Args:
            path (PathSpec): Root of the stale subtree; only ``virtual``
                is read.
        """
        key = await self._invalidate_path(path)
        await self._drop_below(key)
        await self._invalidate_removed(key)

    async def invalidate_after_remove(self, path: PathSpec) -> None:
        """Invalidate caches after ``path`` was removed, folder or file.

        For a remover that cannot say which it removed: a watched
        DELETE, or the vacated side of a MOVE, names a path and nothing
        more. A folder needs what was cached beneath it dropped, since
        each nested listing and body was cached under its own key.
        Every removal retires this manager's reads. The subtree drop
        additionally invalidates the file store's pending fills and,
        on a Redis file cache, scans the whole keyspace, which a plain
        file must not pay on every event. So the index is asked whether a
        listing is still cached at the path or under it, and only then
        does the subtree go; otherwise this is
        ``invalidate_after_unlink``.

        The body goes before the index is asked, so an index that
        cannot answer still leaves the removed file unserved. The own
        and parent listing evictions are attempted even if the probe or
        subtree drop fails; failures remain visible to the caller. A folder
        with no listing cached at or under it keeps any bodies cached
        beneath it until their ttl: nothing there was listed, or every
        such listing was evicted since. Each event evicts the listing of
        the changed path's folder and of every folder above it, not their
        other subfolders, and a write evicts at least its own folder's
        listing. A store that never caches holds no listing, so a removal
        on it reads as a file.

        Args:
            path (PathSpec): Path that was removed; only ``virtual`` is
                read.
        """
        key = await self._invalidate_path(path)
        try:
            if await self._index.holds_subtree(key):
                await self._drop_below(key)
        finally:
            await self._invalidate_removed(key)

    async def invalidate_ancestors(self, path: PathSpec) -> None:
        """Evict the listing of every directory above ``path``'s parent.

        ``invalidate_after_write`` refreshes the immediate parent only. A
        keyed store materializes every missing level of a key in a single
        put, so the listings further up gained entries too and would keep
        serving the pre-write view until the index TTL expires. A backend
        with real directories cannot gain a level that way, so there this
        is a handful of spare evictions.

        Args:
            path (PathSpec): Path that was mutated; only ``virtual`` is
                read.
        """
        parent = self._cache_key(path).rsplit("/", 1)[0]
        while parent and parent != self._prefix:
            parent = parent.rsplit("/", 1)[0]
            await self._evict_dir(parent or "/")

    async def drop_prefix(self) -> None:
        """Drop every cached body under this mount, path unspecified.

        For a mutation that names no path: an account CLI writes to its
        service by id, so nothing here can say which file changed, only
        that this mount's bytes may no longer match the service. Clearing
        the listing alone is not enough, because an already-read body is
        served warm and would keep answering with the pre-write content.

        Over-evicts when this mount is the root and another mount sits
        beneath it, since keys are compared by prefix. That costs a
        refetch, which is the safe direction to be wrong in.
        """
        self._retire()
        if not self._caches_reads or self._file_cache is None:
            return
        await self._file_cache.evict_prefix(self._prefix + "/")

    async def _invalidate_path(self, path: PathSpec) -> str:
        self._retire()
        key = self._cache_key(path)
        if self._caches_reads and self._file_cache is not None:
            await self._file_cache.remove(key)
        return key

    async def _invalidate_removed(self, key: str) -> None:
        await self._evict_dir(key)
        await self._invalidate_parent(key)

    async def _drop_below(self, key: str) -> None:
        if self._caches_reads and self._file_cache is not None:
            await self._file_cache.evict_prefix(key.rstrip("/") + "/")
        await self._index.invalidate_prefix(key)

    async def _invalidate_parent(self, key: str) -> None:
        await self._evict_dir(key.rsplit("/", 1)[0] or "/")
