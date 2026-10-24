import asyncio
import logging
import re
import time
from collections.abc import AsyncGenerator, AsyncIterator, Awaitable, Callable
from contextlib import aclosing
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from functools import partial
from typing import Any, Protocol, TypeVar

from mirage.accessor.base import Accessor
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

    def vfs_md(self) -> str:
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

# A channel's messages from a run's first day through its last, a page at
# a time, as ``pages(channel_id, first, last)``.
RunPages = Callable[
    [str, str, str], AsyncGenerator[list[dict[str, Any]], None]
]


def day_channel_id(
    path: PathSpec, entry: FileStat | None, parent: FileStat | None
) -> str:
    """The channel a day's chat.jsonl reads, proven by the listing.

    The typed ``name__id`` dirname is only trusted once a listing proves
    it, so a fabricated channel id is ENOENT rather than a raw API error.
    The file's row carries its channel, and so does its day's, which a
    day the window does not list still has: a sealed day lists nothing
    but the file still reads through the channel, reproducing the API's
    own answer for the fetch.

    Args:
        path (PathSpec): the chat.jsonl path.
        entry (FileStat | None): the file's row, when its day lists it.
        parent (FileStat | None): the day's row.
    """
    for row in (entry, parent):
        channel = row.extra.get("channel_id") if row is not None else None
        if isinstance(channel, str) and channel:
            return channel
    raise enoent(path.virtual)


def day_stat(guard: Guard[A] | None = None) -> StatHook[A]:
    """Stat a day directory, which resolves beyond the listed window.

    The parent listing synthesizes a bounded window of recent days, but
    the API answers a range query for any date, so a well-formed day
    under a channel or label that exists is a directory whether or not
    the window lists it, carrying its parent's ids as a listed day does.
    A bogus parent chain is ENOENT.

    Args:
        guard (Guard | None): refuses a day outside the mount's scope
            before any lookup, ``guard_day`` on a scoped mount.
    """

    async def stat(
        accessor: A,
        match: ScopeMatch,
        path: PathSpec,
        entry: FileStat | None,
        parent: FileStat | None,
    ) -> FileStat:
        if guard is not None:
            await guard(accessor, match, path.virtual)
        if entry is not None:
            return entry
        if parent is None:
            raise enoent(path.virtual)
        return FileStat(
            name=match.slots["day"],
            type=FileType.DIRECTORY,
            extra=dict(parent.extra),
        )

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
    scope: TimeRange,
    paths: list[PathSpec],
    entries: list[FileStat | None],
    parents: list[FileStat | None],
    detect: DetectFn,
    pages: RunPages,
    order: Callable[[dict[str, Any]], float],
    within: Callable[[dict[str, Any], float, float], bool],
    limit: int,
) -> dict[str, bytes]:
    """Several chat days' chat.jsonl files, one walk per run of a
    channel's consecutive days.

    Each file is proven as its own read proves it (a day in scope, a
    channel the listing holds); one that is not, or is no chat file, is
    left out for its own read to answer, as is a day past ``limit``
    bytes. Each day's lines are the run's messages posted within it,
    oldest first, as its own read lists them.

    Args:
        scope (TimeRange): the mount's time scope, bounding each day.
        paths (list[PathSpec]): the files.
        entries (list[FileStat | None]): what is at each path, as its
            day's listing names it.
        parents (list[FileStat | None]): each path's day.
        detect (DetectFn): the backend's scope classifier.
        pages (RunPages): a channel's messages from a run's first day
            through its last, a page at a time, as
            ``pages(channel_id, first, last)``.
        order (Callable): a message's place among its day's lines.
        within (Callable): whether a message was posted in a day's
            bounds, as ``within(message, start, end)``.
        limit (int): the most bytes worth reading for one day.
    """
    days: dict[str, dict[str, str]] = {}
    for path, entry, parent in zip(paths, entries, parents, strict=True):
        match = detect(path)
        if match.kind != "messages":
            continue
        try:
            scope.require_day(match.slots["day"], path.virtual)
            channel_id = day_channel_id(path, entry, parent)
        except FileNotFoundError as exc:
            logger.debug("read_days leaves out %s: %s", path.virtual, exc)
            continue
        days.setdefault(channel_id, {})[match.slots["day"]] = path.virtual
    read = partial(
        _read_run,
        scope=scope,
        pages=pages,
        order=order,
        within=within,
        limit=limit,
    )
    answers: dict[str, bytes] = {}
    for channel_id, named in days.items():
        run: list[str] = []
        for day in sorted(named):
            if run and date.fromisoformat(day) - date.fromisoformat(
                run[-1]
            ) != timedelta(days=1):
                answers.update(await read(channel_id, run, named))
                run = []
            run.append(day)
        answers.update(await read(channel_id, run, named))
    return answers


async def _read_run(
    channel_id: str,
    run: list[str],
    named: dict[str, str],
    *,
    scope: TimeRange,
    pages: RunPages,
    order: Callable[[dict[str, Any]], float],
    within: Callable[[dict[str, Any], float, float], bool],
    limit: int,
) -> dict[str, bytes]:
    """One run of a channel's consecutive days, walked once.

    The walk stops, and the run is left out, once its messages pass
    ``limit`` bytes a day: no more than that could be kept, and each
    day's own read answers it.

    Args:
        channel_id (str): the channel.
        run (list[str]): its days, consecutive and ascending.
        named (dict[str, str]): each day's file, by day.
        scope (TimeRange): as ``read_days`` takes it.
        pages (RunPages): as ``read_days`` takes it.
        order (Callable): as ``read_days`` takes it.
        within (Callable): as ``read_days`` takes it.
        limit (int): as ``read_days`` takes it.
    """
    budget = limit * len(run)
    lines: list[tuple[dict[str, Any], bytes]] = []
    size = 0
    async with aclosing(pages(channel_id, run[0], run[-1])) as walk:
        async for page in walk:
            for message in page:
                line = jsonl_bytes([message])
                lines.append((message, line))
                size += len(line)
            if size > budget:
                logger.debug(
                    "read_days leaves out %s from %s: past %d bytes",
                    channel_id,
                    run[0],
                    budget,
                )
                return {}
    lines.sort(key=lambda pair: order(pair[0]))
    answers: dict[str, bytes] = {}
    for day in run:
        start, end = scope.day_bounds(day)
        body = b"".join(line for m, line in lines if within(m, start, end))
        if len(body) <= limit:
            answers[named[day]] = body
    return answers
