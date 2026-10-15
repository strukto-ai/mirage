import asyncio
import logging
import re
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any, Protocol, TypeVar

from mirage.accessor.base import Accessor
from mirage.cache.index import IndexCacheStore
from mirage.core.hierarchy.probe import (
    ReaddirFn,
    ancestor_entry,
    resolve_entry,
)
from mirage.core.hierarchy.readdir import Guard
from mirage.core.hierarchy.scope import DetectFn, ScopeMatch
from mirage.core.hierarchy.stat import StatHook
from mirage.core.render.json import jsonl_bytes
from mirage.errors.fs import enoent
from mirage.types import FileStat, FileType, PathSpec

logger = logging.getLogger(__name__)

TIMESTAMP = re.compile(
    r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})\Z"
)


def parse_time(value: str) -> float:
    """Parse an RFC3339 timestamp with at most millisecond precision.

    Args:
        value (str): timestamp with an explicit UTC offset.
    """
    if not TIMESTAMP.fullmatch(value) or (
        not value.endswith("Z")
        and (int(value[-5:-3]) > 23 or int(value[-2:]) > 59)
    ):
        raise ValueError(
            "expected RFC3339 timestamp with timezone "
            "and at most millisecond precision"
        )
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


@dataclass(frozen=True)
class TimeRange:
    start: float | None = None
    end: float | None = None

    @classmethod
    def from_strings(cls, start: str | None, end: str | None) -> "TimeRange":
        return cls(
            parse_time(start) if start is not None else None,
            parse_time(end) if end is not None else None,
        )

    @property
    def bounded(self) -> bool:
        return self.start is not None or self.end is not None

    def clip(self, start: float, end: float) -> tuple[float, float]:
        return (
            max(start, self.start) if self.start is not None else start,
            min(end, self.end) if self.end is not None else end,
        )

    def day_bounds(self, day: str) -> tuple[float, float]:
        start = datetime.fromisoformat(day).replace(tzinfo=timezone.utc)
        return self.clip(
            start.timestamp(), (start + timedelta(days=1)).timestamp()
        )

    def require_day(self, day: str, path: str) -> None:
        start, end = self.day_bounds(day)
        if start >= end:
            raise enoent(path)

    def listing_days(
        self, first: date, last: date, span: tuple[date, date] | None = None
    ) -> list[str]:
        if self.start is not None:
            first = max(
                first, datetime.fromtimestamp(self.start, timezone.utc).date()
            )
        if self.end is not None:
            last = min(
                last, datetime.fromtimestamp(self.end, timezone.utc).date()
            )
        if span is not None:
            first, last = (
                max(first, span[0]),
                min(last, span[1] - timedelta(days=1)),
            )
        out = []
        while first <= last:
            day = first.isoformat()
            lo, hi = self.day_bounds(day)
            if lo < hi:
                out.append(day)
            first += timedelta(days=1)
        return out

    def prompt(self) -> str:
        start = (
            datetime.fromtimestamp(self.start, timezone.utc).isoformat()
            if self.start is not None
            else "unbounded"
        )
        end = (
            datetime.fromtimestamp(self.end, timezone.utc).isoformat()
            if self.end is not None
            else "unbounded"
        )
        return (
            f"\n  Time scope: start_time={start} (inclusive), "
            f"end_time={end} (exclusive). "
            "Explicit paths and globs cannot escape this scope."
        )


class TimeRangeAccessor(Protocol):
    time_range: TimeRange


async def guard_day(
    accessor: TimeRangeAccessor, match: ScopeMatch, virtual: str
) -> None:
    """Refuse a UTC day outside the mount's scope, before cache lookup.

    Args:
        accessor (TimeRangeAccessor): scoped accessor.
        match (ScopeMatch): classified path containing a day slot.
        virtual (str): path reported in ENOENT.
    """
    accessor.time_range.require_day(match.slots["day"], virtual)


A = TypeVar("A", bound=Accessor)


async def day_channel_id(
    readdir: ReaddirFn[A], accessor: A, path: PathSpec, index: IndexCacheStore
) -> str:
    """The channel a day's chat.jsonl reads, proven by the listing.

    The typed ``name__id`` dirname is only trusted once the listing
    proves it, so a fabricated channel id is ENOENT rather than a raw
    API error. A sealed day lists nothing but the file still reads
    through the channel, reproducing the API's own answer for the fetch.

    Args:
        readdir (ReaddirFn): the backend's readdir.
        accessor (Accessor): backend accessor.
        path (PathSpec): the chat.jsonl path.
        index (IndexCacheStore): index cache.
    """
    entry = await resolve_entry(readdir, accessor, path, index)
    if entry is not None:
        return entry.id.split(":", 1)[0]
    channel = await ancestor_entry(readdir, accessor, path, index, up=2)
    if channel is None:
        raise enoent(path.virtual)
    return channel.id


def day_stat(
    readdir: ReaddirFn[A], guard: Guard[A] | None = None
) -> StatHook[A]:
    """Stat a day directory, which resolves beyond the listed window.

    The parent listing synthesizes a bounded window of recent days, but
    the API answers a range query for any date, so a well-formed day
    under a parent that exists is a directory whether or not the window
    lists it. A bogus parent chain is ENOENT.

    Args:
        readdir (ReaddirFn): the backend's readdir.
        guard (Guard | None): refuses a day outside the mount's scope
            before any lookup, ``guard_day`` on a scoped mount.
    """

    async def stat(
        accessor: A, match: ScopeMatch, path: PathSpec, index: IndexCacheStore
    ) -> FileStat:
        if guard is not None:
            await guard(accessor, match, path.virtual)
        entry = await resolve_entry(readdir, accessor, path, index)
        if entry is not None:
            return FileStat(name=entry.vfs_name, type=FileType.DIRECTORY)
        if await ancestor_entry(readdir, accessor, path, index, up=1) is None:
            raise enoent(path.virtual)
        return FileStat(name=match.slots["day"], type=FileType.DIRECTORY)

    return stat


async def followed_day(
    messages: list[dict[str, Any]],
    n: int,
    end: float,
    interval: float,
    after: Callable[[dict[str, Any] | None], Awaitable[list[dict[str, Any]]]],
) -> AsyncIterator[bytes]:
    """A chat day's last ``n`` messages, then each one posted to it after
    them, as its chat.jsonl lines.

    ``messages`` is the day as a read lists it, so its last ``n`` come
    first. Then every ``interval`` seconds ``after`` is asked for the
    messages posted since the last one seen (the whole day while none
    is), until a poll that starts once the day is over: nothing can land
    in it after that, and the stream waits to be closed, as ``tail -f``
    waits on a file that stops growing. Each ask starts where the last
    answer ended, so none is lost or printed twice.

    Args:
        messages (list[dict[str, Any]]): the day so far, oldest first.
        n (int): how many of its last lines come first, 0 for none.
        end (float): when the day, clipped to the mount's scope, ends.
        interval (float): seconds between two asks.
        after (Callable): the messages after the one given, oldest
            first.
    """
    last = messages[-1] if messages else None
    if n > 0 and messages:
        yield jsonl_bytes(messages[-n:])
    while True:
        await asyncio.sleep(interval)
        closed = time.time() >= end
        added = await after(last)
        if added:
            last = added[-1]
            yield jsonl_bytes(added)
        if closed:
            break
    await asyncio.Event().wait()


async def read_days(
    readdir: ReaddirFn[A],
    accessor: A,
    scope: TimeRange,
    paths: list[PathSpec],
    index: IndexCacheStore,
    detect: DetectFn,
    fetch: Callable[[str, str, str], Awaitable[list[dict[str, Any]]]],
    within: Callable[[dict[str, Any], float, float], bool],
) -> dict[str, bytes]:
    """Several chat days' chat.jsonl files, one fetch per run of a
    channel's consecutive days.

    Each file is proven as its own read proves it (a day in scope, a
    channel the listing holds); one that is not, or is no chat file, is
    left out for its own read to answer. Each day's lines are the run's
    messages posted within it, oldest first, as its own read lists them.

    Args:
        readdir (ReaddirFn): the backend's readdir.
        accessor (Accessor): backend accessor.
        scope (TimeRange): the mount's time scope, bounding each day.
        paths (list[PathSpec]): the files.
        index (IndexCacheStore): index cache.
        detect (DetectFn): the backend's scope classifier.
        fetch (Callable): a channel's messages from a run's first day
            through its last, oldest first, as
            ``fetch(channel_id, first, last)``.
        within (Callable): whether a message was posted in a day's
            bounds, as ``within(message, start, end)``.
    """
    days: dict[str, dict[str, str]] = {}
    for path in paths:
        match = detect(path)
        if match.kind != "messages":
            continue
        try:
            scope.require_day(match.slots["day"], path.virtual)
            channel_id = await day_channel_id(readdir, accessor, path, index)
        except FileNotFoundError as exc:
            logger.debug("read_days leaves out %s: %s", path.virtual, exc)
            continue
        days.setdefault(channel_id, {})[match.slots["day"]] = path.virtual
    answers: dict[str, bytes] = {}
    for channel_id, named in days.items():
        run: list[str] = []
        for day in sorted(named):
            if run and date.fromisoformat(day) - date.fromisoformat(
                run[-1]
            ) != timedelta(days=1):
                answers.update(
                    await _read_run(
                        channel_id, run, named, scope, fetch, within
                    )
                )
                run = []
            run.append(day)
        answers.update(
            await _read_run(channel_id, run, named, scope, fetch, within)
        )
    return answers


async def _read_run(
    channel_id: str,
    run: list[str],
    named: dict[str, str],
    scope: TimeRange,
    fetch: Callable[[str, str, str], Awaitable[list[dict[str, Any]]]],
    within: Callable[[dict[str, Any], float, float], bool],
) -> dict[str, bytes]:
    """One run of a channel's consecutive days, fetched once.

    Args:
        channel_id (str): the channel.
        run (list[str]): its days, consecutive and ascending.
        named (dict[str, str]): each day's file, by day.
        scope (TimeRange): the mount's time scope, bounding each day.
        fetch (Callable): as ``read_days`` takes it.
        within (Callable): as ``read_days`` takes it.
    """
    messages = await fetch(channel_id, run[0], run[-1])
    answers: dict[str, bytes] = {}
    for day in run:
        start, end = scope.day_bounds(day)
        answers[named[day]] = jsonl_bytes(
            [m for m in messages if within(m, start, end)]
        )
    return answers
