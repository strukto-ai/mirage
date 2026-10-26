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

import threading
from collections import Counter, OrderedDict
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from time import monotonic

from mirage.cache.index.config import ListResult
from mirage.cache.index.constants import LISTING_TRUST_WINDOW, ROW_READ_BATCH
from mirage.cache.index.scope import sole_command_started
from mirage.types import FileStat
from mirage.utils.clock import Clock

_WRITES_BY_PREFIX: Counter[str] = Counter()
_ROW_WRITES_BY_PREFIX: Counter[str] = Counter()
# Each row written within the last window, with its write count and time.
_ROWS_WRITTEN_BY_PREFIX: dict[str, OrderedDict[str, tuple[int, float]]] = {}
_HOLDERS_BY_PREFIX: Counter[str] = Counter()
_PREFIX_LOCK = threading.Lock()


@dataclass
class _Read:
    writes_before: int
    read_at: float
    expires_at: float
    listing: ListResult
    row_writes: int = -1
    rows: dict[str, FileStat | None] = field(default_factory=dict)
    # Where each listed key sits, built on the first lookup of one.
    positions: dict[str, int] | None = None


def _positions(kept: _Read) -> dict[str, int]:
    if kept.positions is None:
        keys = kept.listing.entries or kept.listing.partial_entries or []
        kept.positions = {key: at for at, key in enumerate(keys)}
    return kept.positions


def _answer(
    listing: ListResult, child: str | None, kept: _Read | None
) -> ListResult:
    """A listing as ``read`` answers it: a kept one copied, so a
    caller's edit never reaches it, or, given ``child``, narrowed to
    that key where it is listed.

    Args:
        listing (ListResult): the listing read.
        child (str | None): the key to narrow the entries to.
        kept (_Read | None): the read that keeps the listing, if any.
    """
    if child is None and kept is None:
        return listing
    named = child is not None and (
        child in (listing.entries or listing.partial_entries or [])
        if kept is None
        else child in _positions(kept)
    )

    def keys(entries: list[str] | None) -> list[str] | None:
        if entries is None:
            return None
        if child is None:
            return list(entries)
        return [child] if named else []

    return listing.model_copy(
        update={
            "entries": keys(listing.entries),
            "partial_entries": keys(listing.partial_entries),
        }
    )


class ListingMemo:
    """The listings one store read for the running commands.

    A read is served again only to the command that made it, only while
    no listing write to the key prefix has finished since the read began,
    for under LISTING_TRUST_WINDOW seconds, and never past the listing's
    own expiry. Row reads batch at most ROW_READ_BATCH siblings and share
    this lifetime, a row the batch did not find is left to a lookup of its
    own, and a row-only write drops that row alone. Each fill drops the
    oldest reads no command can be served any more, so a read stays held
    for about one window. The key prefix's write count lives while an open
    memo holds the prefix.

    Args:
        key_prefix (str): the store's key prefix, whose writes count.
        clock (Clock): the store's clock, whose wall time a listing's
            expiry is compared with.
    """

    def __init__(self, key_prefix: str, clock: Clock) -> None:
        self._key_prefix = key_prefix
        self._clock = clock
        self._reads: OrderedDict[tuple[int, str], _Read] = OrderedDict()
        self._closed = False
        with _PREFIX_LOCK:
            _HOLDERS_BY_PREFIX[key_prefix] += 1

    def _live(self, kept: _Read) -> bool:
        return (
            kept.writes_before == _WRITES_BY_PREFIX[self._key_prefix]
            and monotonic() - kept.read_at < LISTING_TRUST_WINDOW
            and self._clock.now() < kept.expires_at
        )

    async def read(
        self,
        folder: str,
        fetch: Callable[[], Awaitable[tuple[ListResult, float | None]]],
        child: str | None = None,
    ) -> ListResult:
        """A folder's listing, read from Redis at most once per command.

        Args:
            folder (str): the listed folder's key.
            fetch (Callable[[], Awaitable[tuple[ListResult, float | None]]]):
                reads the listing from Redis and answers it with its
                expiry, or with None when there is no live listing to keep.
            child (str | None): the one key a lookup asks about, to
                narrow the entries to.
        """
        stamp = sole_command_started()
        if stamp is None:
            return _answer((await fetch())[0], child, None)
        kept = self._reads.get((stamp, folder))
        if kept is not None and self._live(kept):
            return _answer(kept.listing, child, kept)
        writes = _WRITES_BY_PREFIX[self._key_prefix]
        read_at = monotonic()
        listing, expires_at = await fetch()
        if expires_at is None or _WRITES_BY_PREFIX[self._key_prefix] != writes:
            return _answer(listing, child, None)
        while self._reads and not self._live(next(iter(self._reads.values()))):
            self._reads.popitem(last=False)
        read = _Read(writes, read_at, expires_at, listing)
        self._reads.pop((stamp, folder), None)
        self._reads[stamp, folder] = read
        return _answer(listing, child, read)

    async def row(
        self,
        path: str,
        fetch: Callable[[Sequence[str]], Awaitable[dict[str, FileStat]]],
    ) -> FileStat | None:
        """Batch a listed row with its siblings within the listing's lifetime.

        Args:
            path (str): the row's index key.
            fetch (Callable[[Sequence[str]], Awaitable[dict[str, FileStat]]]):
                reads the listed rows in one request.
        """
        stamp = sole_command_started()
        if stamp is None:
            return None
        folder = path.rsplit("/", 1)[0] or "/"
        key = (stamp, folder)
        kept = self._reads.get(key)
        if kept is None or not self._live(kept):
            return None
        writes = _ROW_WRITES_BY_PREFIX[self._key_prefix]
        if kept.row_writes != writes:
            with _PREFIX_LOCK:
                written = _ROWS_WRITTEN_BY_PREFIX.get(self._key_prefix)
                for done, (count, _) in (written or {}).items():
                    if count > kept.row_writes:
                        kept.rows.pop(done, None)
            kept.row_writes = writes
        if path in kept.rows:
            row = kept.rows[path]
        else:
            position = _positions(kept).get(path)
            if position is None:
                return None
            paths = kept.listing.entries or kept.listing.partial_entries or []
            start = position // ROW_READ_BATCH * ROW_READ_BATCH
            missing = [
                p
                for p in paths[start : start + ROW_READ_BATCH]
                if p not in kept.rows
            ]
            fetched = await fetch(missing)
            found = {p: fetched.get(p) for p in missing}
            if (
                self._live(kept)
                and _ROW_WRITES_BY_PREFIX[self._key_prefix] == writes
            ):
                kept.rows.update(found)
            row = found[path]
        return None if row is None else row.model_copy(deep=True)

    def row_wrote(self, path: str) -> None:
        """Count a finished write of one row, keeping its siblings' reads.

        Args:
            path (str): the written row's index key.
        """
        now = monotonic()
        with _PREFIX_LOCK:
            _ROW_WRITES_BY_PREFIX[self._key_prefix] += 1
            written = _ROWS_WRITTEN_BY_PREFIX.setdefault(
                self._key_prefix, OrderedDict()
            )
            written.pop(path, None)
            written[path] = (_ROW_WRITES_BY_PREFIX[self._key_prefix], now)
            while (
                now - next(iter(written.values()))[1] >= LISTING_TRUST_WINDOW
            ):
                written.popitem(last=False)

    def wrote(self) -> None:
        """Count a finished listing write to the key prefix."""
        with _PREFIX_LOCK:
            _WRITES_BY_PREFIX[self._key_prefix] += 1

    def close(self) -> None:
        """Drop the kept listings and release the key prefix.

        The last open memo on a prefix drops its write count, so a host
        that cycles through prefixes keeps none it no longer uses.
        """
        self._reads.clear()
        if self._closed:
            return
        self._closed = True
        with _PREFIX_LOCK:
            _HOLDERS_BY_PREFIX[self._key_prefix] -= 1
            if _HOLDERS_BY_PREFIX[self._key_prefix] <= 0:
                del _HOLDERS_BY_PREFIX[self._key_prefix]
                _WRITES_BY_PREFIX.pop(self._key_prefix, None)
                _ROW_WRITES_BY_PREFIX.pop(self._key_prefix, None)
                _ROWS_WRITTEN_BY_PREFIX.pop(self._key_prefix, None)
