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
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import TypeVar

from mirage.cache.context import capture_read
from mirage.cache.file.io import latest_fingerprint, mutation_lock
from mirage.cache.file.mixin import FileCacheMixin
from mirage.cache.index.config import Evicted
from mirage.cache.index.constants import (
    CHECKED_LIMIT,
    LISTING_TRUST_WINDOW,
    PROBED_LIMIT,
)
from mirage.cache.index.scope import (
    command_started,
    sole_command_started,
    tick,
)
from mirage.cache.index.store import IndexCacheStore
from mirage.cache.index.view import IndexView
from mirage.io.stream import close_quietly
from mirage.observe.context import active_recorder, line_version
from mirage.observe.record import OpRecord
from mirage.types import DEFAULT_READ_TTL, FileChangeKind, FileStat, PathSpec
from mirage.utils.key_prefix import mount_key

logger = logging.getLogger(__name__)

T = TypeVar("T")


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
        self._clock = index.clock
        self._prefix = prefix.rstrip("/")
        self._caches_reads = caches_reads
        self._owns_path = owns_path
        self._read_ttl = read_ttl
        self._on_gone = on_gone
        self._excluded_prefixes = excluded_prefixes
        self._may_serve_listing = may_serve_listing
        self._written: dict[str, tuple[int, float, int | None]] = {}
        self._checked: dict[str, tuple[str, int, float]] = {}
        self._refused: dict[str, tuple[str, int]] = {}
        self._checking: dict[
            str, tuple[int, float, asyncio.Task[str | None]]
        ] = {}
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

    async def drop(self, bodies: bool = True) -> None:
        """Drop this mount's listings and bodies, path unspecified.

        For a write that went past the dispatcher, so nothing here can say
        which file changed, only that this mount may no longer match its
        backend: native code (an external program, a remote runtime line),
        an account CLI writing to its service by id, or a mount command
        writing through its own client. Both caches go, because the two
        hide different writes: a stale listing hides a create or a delete,
        a stale body an edit. It also retires what the running command's
        probes saw.

        The index is expired rather than cleared, while this mount still
        owns it: a cleared index reads exactly like one that was never
        filled, so a backend whose index *is* its listing (github seeds
        the whole tree once) could not tell the drop from an empty
        repository. Over-evicts when this mount is the root and another
        mount sits beneath it, since keys are compared by prefix; a
        refetch is the safe direction to be wrong in.

        Args:
            bodies (bool): drop the bodies too; False when the caller
                clears the whole file cache itself.
        """
        async with self.mutation():
            self.retire()
            if self._owns_path(self._prefix or "/"):
                await self._index.invalidate()
            if bodies and self._caches_reads and self._file_cache is not None:
                await self._file_cache.remove(
                    self._prefix or "/", subtree=True
                )

    def scope_index(self) -> IndexCacheStore:
        """This mount's index, its backend metadata writes bound to the
        mount's lifetime.

        The view is reused because refill locks are keyed by index
        identity.
        """
        if self._file_cache is None:
            return self._index
        if self._view is None:
            self._view = IndexView(
                self._index,
                self._file_cache,
                self._prefix,
                self._owns_path,
                read_ttl=self._read_ttl,
                on_gone=self._cleanup,
                excluded_prefixes=self._excluded_prefixes,
                may_serve_listing=self._may_serve_listing,
                note_written=self._note_written,
                listed_this_command=self.listed_this_command,
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
        self.retire()
        if self._on_gone is not None:
            await self._on_gone(gone)

    def retire(self) -> None:
        """Retire every in-flight read and every remembered probe answer.

        The one step every cache drop takes: a read that began before it
        must not stamp the cache after it, and a probe answer from before
        it must not be served after it.
        """
        self._read_generation += 1
        self._probed.clear()
        self._probe_bound = PROBED_LIMIT

    def _note_written(self, folder: str) -> None:
        self._written[folder] = (
            tick(),
            self._clock.monotonic(),
            sole_command_started(),
        )

    def listed_this_command(self, folder: str) -> bool:
        """Whether the running command fetched ``folder``'s listing itself.

        Stricter than ``listing_trusted``: outside a command no listing is
        the caller's own, and inside one only a listing fetched under the
        same command stamp is: not one another session fetched meanwhile,
        nor one a nested ``$(...)`` or function body fetched. A listing the
        command fetched stays its own until the command ends, so a
        long-running command does not see a name another client creates
        after it listed the folder.

        Args:
            folder (str): mount-absolute listing key.
        """
        written = self._written.get(folder)
        started = sole_command_started()
        return (
            written is not None
            and started is not None
            and written[2] == started
        )

    def listing_trusted(self, folder: str) -> bool:
        """Whether ``folder``'s listing is recent enough to serve under fresh.

        Inside a command: only if it was fetched since the command
        started, so one command re-lists a folder once however often it
        reads it. Outside any command (FUSE, a programmatic op) there is
        no command to belong to, so a listing fetched within
        ``LISTING_TRUST_WINDOW`` seconds is trusted instead: one ``ls -l``
        over FUSE is a burst of calls that can share a re-list until the
        window expires.

        Every view of the mount, shared or lock-held, records into one map,
        so a glob's write counts for the ``ls`` that follows it.

        Args:
            folder (str): mount-absolute listing key.
        """
        written = self._written.get(folder)
        if written is None:
            return False
        stamp, at, _ = written
        started = command_started()
        if started is not None:
            return stamp > started
        return self._clock.monotonic() - at < LISTING_TRUST_WINDOW

    def _prune_checks(self) -> None:
        # A check answers only a caller inside its window, so the rest are
        # dead weight; the next prune waits for the map to double.
        self._checked = {
            key: checked
            for key, checked in self._checked.items()
            if self._sent_recently(checked[1], checked[2])
        }
        self._refused = {
            key: refused
            for key, refused in self._refused.items()
            if key in self._checked and self._checked[key][1] == refused[1]
        }
        self._check_bound = max(CHECKED_LIMIT, 2 * len(self._checked))

    def _sent_recently(self, sent_tick: int, sent_at: float) -> bool:
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
        return self._clock.monotonic() - sent_at < LISTING_TRUST_WINDOW

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
        trusted, since the listing may have been written since, unless that
        answer already refused this same ``stored``: nothing about that
        listing changed. The shared check is shielded, so one caller's
        cancellation never reaches the others.

        Args:
            key (str): what the version covers: the mount root, or a folder.
            stored (str): the version stored with the caller's listing.
            check (Callable[[], Awaitable[str | None]]): asks the backend;
                None when it answers no version.
        """
        checked = self._checked.get(key)
        if (
            checked is not None
            and self._sent_recently(checked[1], checked[2])
            and (
                checked[0] == stored
                or self._refused.get(key) == (stored, checked[1])
            )
        ):
            return checked[0]
        flight = self._checking.get(key)
        if flight is None or not self._sent_recently(flight[0], flight[1]):
            flight = self._send_check(key, check)
        version = await asyncio.shield(flight[2])
        checked = self._checked.get(key)
        if version != stored and checked is not None and checked[0] == version:
            self._refused[key] = (stored, checked[1])
        return version

    def _send_check(
        self, key: str, check: Callable[[], Awaitable[str | None]]
    ) -> tuple[int, float, asyncio.Task[str | None]]:
        sent_tick = tick()
        sent_at = self._clock.monotonic()

        async def run() -> str | None:
            version = await check()
            checked = self._checked.get(key)
            # Recorded here rather than by a waiter, so the answer lands
            # even when every waiter was cancelled; an older check that
            # lands late never replaces a newer one.
            if version is not None and (
                checked is None or checked[1] < sent_tick
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
        re-list that found the path gone all retire it (``retire``), so the
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
        entry: FileStat,
    ) -> None:
        """Retain a live fallback row only while its predecessor still owns the slot.

        Args:
            path (PathSpec): confirmed file path.
            generation (int): generation before the remote check.
            predecessor (str): serialized previous index row.
            entry (FileStat): confirmed replacement row.
        """
        key = self._cache_key(path)
        async with self.mutation():
            if generation != self._read_generation or not self._owns_path(key):
                return
            await self._locked_index().replace_if_unchanged(
                key, predecessor, entry
            )

    def _locked_index(self) -> IndexCacheStore:
        """A view for a caller already inside ``mutation()``.

        Never share or retain it beyond that hold. A distinct refill lock
        avoids lock inversion with readers of the shared view.
        """
        if self._file_cache is None:
            return self._index
        return IndexView(
            self._index,
            self._file_cache,
            self._prefix,
            self._owns_path,
            locked=True,
            read_ttl=self._read_ttl,
            on_gone=self._gone_locked,
            excluded_prefixes=self._excluded_prefixes,
            may_serve_listing=self._may_serve_listing,
            note_written=self._note_written,
            listed_this_command=self.listed_this_command,
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

        def token() -> str | None:
            if facts:
                same = all(fp == facts[0] for fp in facts)
                return facts[0] if same else None
            records = recorder.sink[start:] if recorder is not None else None
            return latest_fingerprint(records, key)

        await self._keep(key, data, token, self._admits(generation, keep))
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
            await self._keep(
                key,
                b"".join(chunks),
                lambda: latest_fingerprint(records, key),
                self._admits(generation, keep),
            )

    def _admits(
        self, generation: int, keep: Callable[[], bool] | None
    ) -> Callable[[], bool]:
        """A cold read's last say: no write landed since it began, and
        ``keep`` agrees.

        Args:
            generation (int): the read generation the read began in.
            keep (Callable[[], bool] | None): the caller's last say.
        """
        return lambda: (
            generation == self._read_generation and (keep is None or keep())
        )

    async def keep_written(
        self, path: PathSpec, data: bytes, fingerprint: str | None
    ) -> None:
        """Keep a write's bytes for the next read, as a read keeps its own.

        Args:
            path (PathSpec): the path written.
            data (bytes): the bytes the file now holds.
            fingerprint (str | None): the token the write's backend
                answered, None when it vouched for none.
        """
        await self._keep(
            self._cache_key(path), data, lambda: fingerprint, lambda: True
        )

    async def _keep(
        self,
        key: str,
        data: bytes,
        token: Callable[[], str | None],
        admit: Callable[[], bool],
    ) -> None:
        """Store bytes a read or a write settled on, unless they went stale.

        The one way bytes enter the file cache. The checks run under the
        cache's mutation lock, so a name this mount stopped owning or
        caching keeps nothing, nor do bytes ``admit`` refuses. Bytes over
        the whole cache limit would evict every warm entry, so the copy
        held for the key, now stale, goes instead; a store that refuses
        the bytes (out of memory, a value over its size limit) costs only
        the next read a fetch, so the refusal is logged, never raised, and
        the stale copy goes too.

        Args:
            key (str): the cache key.
            data (bytes): the bytes to keep.
            token (Callable[[], str | None]): their backend token.
            admit (Callable[[], bool]): the last say, asked under the lock.
        """
        cache = self._file_cache
        if cache is None:
            return
        async with mutation_lock(cache):
            if not (self._caches_reads and self._owns_path(key) and admit()):
                return
            try:
                if len(data) > cache.cache_limit:
                    await cache.remove(key)
                else:
                    await cache.set(
                        key, data, fingerprint=token(), ttl=self._read_ttl
                    )
            except Exception:
                logger.warning("cache fill refused for %s", key, exc_info=True)
                try:
                    await cache.remove(key)
                except Exception:
                    logger.warning(
                        "stale copy not dropped for %s", key, exc_info=True
                    )

    async def cached_sizes(self, paths: list[PathSpec]) -> list[int | None]:
        """Return each cached render's byte length, in path order, without
        revalidating or fetching the bytes.

        The size backfill a render-dependent backend cannot answer for
        itself (the dispatcher's stat) runs only where the backend
        reported no size, which is exactly the API mounts, so gating it
        would turn a stat into a backend stat. It answers a length rather
        than content, so nothing can serve unverified bytes through it.

        Args:
            paths (list[PathSpec]): the paths to look up.
        """
        keys = [self._cache_key(path) for path in paths]
        held = [key for key in keys if self._readable_cache(key) is not None]
        if not held or self._file_cache is None:
            return [None] * len(keys)
        sizes = dict(zip(held, await self._file_cache.sizes(held)))
        return [sizes.get(key) for key in keys]

    async def is_cached(self, path: PathSpec) -> bool:
        """Whether a read of ``path`` would be served from the cache,
        asked of the store without fetching the bytes.

        Args:
            path (PathSpec): the path to look up.
        """
        key = self._cache_key(path)
        cache = self._readable_cache(key)
        return cache is not None and await cache.exists(key)

    async def invalidate(
        self,
        path: PathSpec,
        kind: FileChangeKind,
        row: FileStat | None = None,
        *,
        leaf: bool = False,
        probed: FileStat | None = None,
    ) -> None:
        """Drop what a change at ``path`` made stale.

        The kind decides how far down it reaches:

        - CREATE, UPDATE, and MOVE at its landing: the body, and the
          path's entry in its parent's listing. A CREATE that answered
          its new entry's stat (``row``) keeps that entry where the
          parent's listing names it instead, so a listing of the parent
          and the next level of a nested create need no request; a row
          naming another file (a store that matches names without case
          wrote the one it holds) proves nothing, so the parent is
          listed again.
        - DELETE: the body, the path's own listing and its parent entry,
          and what is cached beneath it when a listing at or under it is
          still cached. That probe is for a remover that cannot say it
          removed a folder (a notified DELETE, the vacated side of a
          MOVE): a folder's nested listings and bodies were cached under
          keys of their own, while a plain file must not pay a subtree
          drop, which on a Redis file cache scans the whole keyspace. A
          remover that knows nothing was below (``leaf``: unlink, rmdir)
          skips it. A folder with no listing cached at or under it keeps
          the bodies cached beneath it until their ttl.
        - UNKNOWN: everything cached at and below the path, as a push
          notification that names only a folder, a recursive delete or a
          directory rename needs.

        Then the path's ancestors drop their entries in their parents'
        listings: a keyed store materializes every missing level of a key
        in one put, so those listings gained entries too. Each affected
        listing becomes partial and keeps its unaffected siblings. Every
        change retires this mount's in-flight reads and probe answers, all
        but ``probed``.

        Args:
            path (PathSpec): the changed path; only ``virtual`` is read.
            kind (FileChangeKind): what happened, which decides the reach.
            row (FileStat | None): a CREATE's new entry, kept in its
                parent's listing; None drops that entry.
            leaf (bool): a DELETE whose remover knows nothing was below
                the path.
            probed (FileStat | None): the backend's answer the change was
                found by, which this command's probe keeps serving for
                ``path`` (``probed_stat``) past the retire.
        """
        key = self._cache_key(path)
        try:
            self.retire()
            started = command_started()
            if probed is not None and started is not None:
                self._probed[key] = (started, self._read_generation, probed)
            if self._caches_reads and self._file_cache is not None:
                await self._file_cache.remove(key)
            if kind is FileChangeKind.UNKNOWN:
                await self._drop_below(key)
                await self._invalidate_removed(key)
            elif kind is FileChangeKind.DELETE:
                try:
                    if not leaf and await self._index.holds_subtree(key):
                        await self._drop_below(key)
                finally:
                    await self._invalidate_removed(key)
            elif (
                kind is FileChangeKind.CREATE
                and row is not None
                and row.name == key.rsplit("/", 1)[-1]
            ):
                deadline = (
                    None
                    if self._read_ttl is None
                    else datetime.fromtimestamp(
                        self._index.clock.now(), timezone.utc
                    )
                    + timedelta(seconds=self._read_ttl)
                )
                await self._index.add_entry(key, row, deadline)
            else:
                await self._index.invalidate_entry(key)
        finally:
            parent = key.rsplit("/", 1)[0]
            while parent and parent != self._prefix:
                await self._index.invalidate_entry(parent)
                parent = parent.rsplit("/", 1)[0]

    async def _invalidate_removed(self, key: str) -> None:
        await self._evict_dir(key)
        await self._index.invalidate_entry(key)

    async def _drop_below(self, key: str) -> None:
        excluded = self._excluded_prefixes()
        if self._caches_reads and self._file_cache is not None:
            await self._file_cache.remove(key, subtree=True, excluded=excluded)
        await self._index.invalidate_prefix(key, excluded=excluded)
