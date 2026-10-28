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
from contextlib import aclosing, asynccontextmanager

from mirage.errors.fs import edquot
from mirage.io.cooperative import chunks
from mirage.io.types import ByteSource
from mirage.types import CapacityResult, CapacityState, PathSpec
from mirage.utils.size import parse_limit
from mirage.vfs.errors import VFSConfigError

logger = logging.getLogger(__name__)

SizeOf = Callable[[PathSpec], Awaitable[int]]
CountAll = Callable[[], Awaitable[int]]


class StorageUsage:
    """One store's capacity and the bytes counted against it.

    ``used`` is None until the store is counted. ``pending`` holds bytes a
    stream or an awaiting write admitted and has not landed yet. ``active``
    holds the writes in flight. Every method but
    ``counted`` is synchronous, so a check and the change it guards run as
    one step on the store's event loop, which is what makes parallel
    writers safe without a lock. Two writes in flight on overlapping paths
    (a file and its folder) can both measure the same bytes, so they lose
    the credit for the bytes they replace and mark the count for a
    recount, which waits until no write is in flight. It serves one
    running event loop at a time: a store whose loop still runs refuses
    another, whose check could race it from a second thread. The
    count lives in this object: another process, or another VFS on the
    same disk folder or Redis prefix, counts on its own, so together they
    can pass the limit. Mirrors the TS ``StorageUsage``.
    """

    def __init__(self, limit: int, used: int | None = None) -> None:
        self.limit = limit
        self.used = used
        self.pending = 0
        self.active: list[Charge] = []
        self.dirty = False
        self._counting: asyncio.Future[None] | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    async def counted(self, count: CountAll) -> None:
        """Count the store when it is uncounted, or marked for a recount
        and no write is in flight; parallel callers wait on one count.

        Args:
            count (CountAll): the bytes the whole store holds.
        """
        self._bind()
        while (
            self.used is None
            or self._counting is not None
            or (self.dirty and not self.active)
        ):
            if self._counting is None:
                self.dirty = False
                self._counting = asyncio.ensure_future(self._count(count))
            await asyncio.shield(self._counting)

    async def _count(self, count: CountAll) -> None:
        try:
            self.used = await count()
        except BaseException:
            self.dirty = True
            raise
        finally:
            self._counting = None

    def _bind(self) -> None:
        loop = asyncio._get_running_loop()
        if loop is None or loop is self._loop:
            return
        if self._loop is not None and self._loop.is_running():
            raise RuntimeError(
                "a store with a capacity serves one event loop at a time"
            )
        self._loop = loop

    def stale(self) -> None:
        """Count the store again once no write is in flight, as bytes
        written past mirage (a native program on a disk folder) went
        uncounted."""
        self.dirty = True

    def enter(self, held: "Charge") -> None:
        """Mark a write in flight; one overlapping another in flight takes
        both off their credit and marks the count for a recount.

        Args:
            held (Charge): the write's charge.
        """
        self._bind()
        for other in self.active:
            if _overlaps(other.path, held.path):
                other.contended = held.contended = self.dirty = True
        self.active.append(held)

    def leave(self, held: "Charge") -> None:
        """Mark a write done.

        Args:
            held (Charge): the charge ``enter`` took.
        """
        self.active.remove(held)

    def admit(self, path: PathSpec, growth: int) -> None:
        """Raise ``edquot(path)`` when positive growth would pass the limit.

        Args:
            path (PathSpec): the operand the refusal names.
            growth (int): bytes the change adds; zero or less always passes,
                and reaching the limit exactly passes.
        """
        self._bind()
        if growth <= 0:
            return
        assert self.used is not None
        if self.used + self.pending + growth > self.limit:
            raise edquot(path)

    def hold(self, path: PathSpec, size: int) -> None:
        """Admit ``size`` and keep it in ``pending`` until it lands.

        Args:
            path (PathSpec): the operand a refusal names.
            size (int): the bytes about to be written.
        """
        self.admit(path, size)
        self.pending += size

    def land(self, held: int, delta: int) -> None:
        """Take ``held`` out of ``pending`` and add the measured ``delta``.

        Args:
            held (int): bytes this writer put in ``pending``.
            delta (int): the change the store really took.
        """
        self.pending -= held
        if self.used is not None:
            self.used += delta

    def report(self) -> CapacityResult:
        """df's QUOTA row: total is the limit, available never below 0."""
        if self.used is None:
            return CapacityResult(state=CapacityState.UNKNOWN)
        return CapacityResult(
            state=CapacityState.QUOTA,
            total=self.limit,
            used=self.used,
            available=max(self.limit - self.used, 0),
        )


def _overlaps(a: PathSpec, b: PathSpec) -> bool:
    x = a.vfs_path.rstrip("/")
    y = b.vfs_path.rstrip("/")
    return x == y or x.startswith(y + "/") or y.startswith(x + "/")


def storage_usage(
    name: str, capacity: int | str | None, used: int | None = None
) -> StorageUsage | None:
    """A backend's usage for its ``capacity`` setting; None for no cap.

    Args:
        name (str): the backend's name, which a refusal starts with.
        capacity (int | str | None): the setting, a size like ``100MB`` or
            a count of bytes.
        used (int | None): the bytes it starts with when the backend knows
            them, as an empty RAM store does; None to count them later.

    Raises:
        VFSConfigError: the setting is not a size.
    """
    if capacity is None:
        return None
    try:
        limit = parse_limit(capacity, "capacity")
    except ValueError as exc:
        raise VFSConfigError(f"{name}: {exc}") from exc
    return StorageUsage(limit, used)


class Charge:
    """What one write reserves against a counted store, and the bytes it
    held so far; inert for an uncapped store. A replacement is credited
    with the bytes it replaces until another write overlaps it
    (``contended``), as that write may move those bytes elsewhere.

    Args:
        usage (StorageUsage | None): the store's usage; None when uncapped.
        path (PathSpec): the operand a refusal names.
        before (int): the bytes at ``path`` before the write.
    """

    def __init__(
        self, usage: StorageUsage | None, path: PathSpec, before: int = 0
    ) -> None:
        self.usage = usage
        self.path = path
        self.before = before
        self.held = 0
        self.written = 0
        self.contended = False

    def hold(self, size: int) -> None:
        """Reserve ``size`` more bytes, or refuse with EDQUOT.

        Args:
            size (int): bytes the write may add.
        """
        if self.usage is not None and size > 0:
            self.usage.hold(self.path, size)
            self.held += size

    @property
    def reserved(self) -> int:
        """The length the operand may reach within what this charge
        holds and is credited with."""
        return (0 if self.contended else self.before) + self.held

    def grow_to(self, size: int) -> None:
        """Reserve what growing the operand to ``size`` bytes adds past
        what this charge already holds.

        Args:
            size (int): the operand's length after the write.
        """
        self.hold(size - self.reserved)

    def stream(self, data: ByteSource, append: bool = False) -> ByteSource:
        """``data``, each chunk reserved as the writer takes it.

        Args:
            data (ByteSource): the bytes being written.
            append (bool): whether they go after the operand's bytes; a
                replacement reserves only what passes the bytes it replaces.
        """
        if self.usage is None:
            return data
        if isinstance(data, bytes):
            self._take(len(data), append)
            return data
        return self._held(data, append)

    def _take(self, size: int, append: bool) -> None:
        self.written += size
        if append:
            self.hold(size)
        else:
            self.grow_to(self.written)

    async def _held(
        self, data: ByteSource, append: bool
    ) -> AsyncIterator[bytes]:
        async with aclosing(chunks(data)) as source:
            async for chunk in source:
                self._take(len(chunk), append)
                yield chunk


@asynccontextmanager
async def charge(
    usage: StorageUsage | None,
    path: PathSpec,
    size_of: SizeOf,
    count: CountAll,
) -> AsyncIterator[Charge]:
    """Reserve before a write's bytes go and land what it really changed.

    The reservation is checked and taken in one synchronous step, so
    parallel writers on the store's loop can never pass its capacity
    together. After the write, however it ended, the operand is measured
    again and the change lands; a write that overlapped another in flight
    marks the count for a recount. An uncapped store yields an inert
    charge and measures nothing.

    Args:
        usage (StorageUsage | None): the store's usage; None when uncapped.
        path (PathSpec): the operand the write changes.
        size_of (SizeOf): the bytes at a path, a directory's included;
            0 for none.
        count (CountAll): the bytes the whole store holds.
    """
    if usage is None:
        yield Charge(None, path)
        return
    await usage.counted(count)
    held = Charge(usage, path)
    usage.enter(held)
    try:
        before = held.before = await size_of(path)
        try:
            yield held
        finally:
            try:
                after = await size_of(path)
            except BaseException:
                logger.debug(
                    "re-measuring %s failed; recounting", path.virtual
                )
                usage.land(held.held, 0)
                usage.stale()
                raise
            usage.land(held.held, after - before)
    finally:
        usage.leave(held)
