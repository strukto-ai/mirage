import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Protocol, TypeVar

from mirage.accessor.base import Accessor
from mirage.cache.index import IndexCacheStore
from mirage.core.hierarchy.probe import (
    ReaddirFn,
    ancestor_entry,
    resolve_entry,
)
from mirage.core.hierarchy.readdir import Guard
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.hierarchy.stat import StatHook
from mirage.errors.fs import enoent
from mirage.types import FileStat, FileType, PathSpec

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
