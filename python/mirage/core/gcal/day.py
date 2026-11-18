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
import re
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from mirage.types import JsonValue

logger = logging.getLogger(__name__)

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
DEFAULT_TZ = "UTC"
WINDOW_AHEAD_DAYS = 90
# A Monday, so the 7-day buckets tiled from it are ISO weeks.
BUCKET_EPOCH = date(1970, 1, 5)
SPAN_SEP = "--"


def zone(tz: str) -> ZoneInfo:
    """Resolve an IANA zone name, falling back to UTC when unknown.

    Args:
        tz (str): IANA time zone name.

    Returns:
        ZoneInfo: the resolved zone.
    """
    try:
        return ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError):
        # A calendar can name a zone this platform's tzdata does not carry.
        # Failing the whole listing over it would let one bad calendar hide
        # every other one, so fall back loudly and keep going.
        logger.debug(
            "gcal: unknown time zone %r, bucketing in %s", tz, DEFAULT_TZ
        )
        return ZoneInfo(DEFAULT_TZ)


def local_midnight(day: str, tz: str) -> datetime:
    """The instant at which a local calendar day begins.

    Args:
        day (str): a floating date, ``YYYY-MM-DD``.
        tz (str): IANA time zone name.

    Returns:
        datetime: tz-aware datetime at 00:00 local.
    """
    parts = [int(p) for p in day.split("-")]
    return datetime(parts[0], parts[1], parts[2], tzinfo=zone(tz))


def day_bounds(day: str, tz: str, days: int = 1) -> tuple[str, str]:
    """The RFC3339 timeMin/timeMax pair covering local days from one day.

    Computed as local midnights rather than start + 24h: a local day is 23
    or 25 hours on the two DST transitions each year, and adding a fixed
    day would drop or double an hour of events.

    Args:
        day (str): the first floating date, ``YYYY-MM-DD``.
        tz (str): IANA time zone name.
        days (int): how many consecutive days the pair covers.

    Returns:
        tuple[str, str]: (timeMin, timeMax) as RFC3339 with offsets.
    """
    start = local_midnight(day, tz)
    nxt = (start.date() + timedelta(days=days)).isoformat()
    return start.isoformat(), local_midnight(nxt, tz).isoformat()


def bucket_start(day: date, size: int) -> date:
    """The first day of the bucket that holds a day.

    Buckets tile a fixed grid from ``BUCKET_EPOCH`` rather than one centred
    on today, so a directory name means the same days whenever it is
    listed. The first bucket of the calendar era is cut short at
    ``date.min`` instead of starting before it.

    Args:
        day (date): any day.
        size (int): the mount's bucket length in days.
    """
    ordinal = day.toordinal()
    offset = (ordinal - BUCKET_EPOCH.toordinal()) % size
    return date.fromordinal(max(ordinal - offset, 1))


def bucket_name(start: date, size: int) -> str:
    """The directory name of the bucket opening on a day.

    A one-day bucket is spelled as the day, which keeps the default tree
    as it was; a longer one names its first and last day, so the name says
    which days it holds without the reader knowing the mount's size.

    Args:
        start (date): the bucket's first day.
        size (int): the bucket length in days.
    """
    if size == 1:
        return start.isoformat()
    last = start + timedelta(days=size - 1)
    return f"{start.isoformat()}{SPAN_SEP}{last.isoformat()}"


def valid_bucket(name: str) -> bool:
    """Whether a name is shaped like a bucket: a real day or a span of two.

    Shape only: whether the bucket lies on a mount's grid depends on that
    mount's size, which ``parse_bucket`` checks.

    Args:
        name (str): the candidate directory name.
    """
    first, sep, last = name.partition(SPAN_SEP)
    return valid_day(first) and (not sep or valid_day(last))


def parse_bucket(name: str, size: int) -> date | None:
    """The first day of the bucket a name spells on a mount's grid.

    Each bucket has exactly one spelling per mount: a span off the grid,
    of the wrong length, or a bare day on a multi-day mount spells none.

    Args:
        name (str): the directory name.
        size (int): the mount's bucket length in days.

    Returns:
        date | None: the bucket's first day, or None.
    """
    if not valid_bucket(name):
        return None
    start = date.fromisoformat(name.partition(SPAN_SEP)[0])
    if bucket_start(start, size) != start or bucket_name(start, size) != name:
        return None
    return start


def window_bounds(today: date, tz: str, size: int = 1) -> tuple[None, str]:
    """The default listing bounds: all past events and a future horizon.

    The horizon, the end of the bucket holding the day
    ``WINDOW_AHEAD_DAYS`` past today, is what keeps a recurring event
    without an end from expanding forever; ending on a bucket edge decides
    the last bucket on all of its days.

    Args:
        today (date): the day the future horizon is measured from.
        tz (str): IANA time zone name.
        size (int): the mount's bucket length in days.

    Returns:
        tuple[None, str]: no timeMin and an RFC3339 timeMax.
    """
    last = bucket_start(today + timedelta(days=WINDOW_AHEAD_DAYS), size)
    return None, day_bounds(last.isoformat(), tz, size)[1]


def valid_day(day: str) -> bool:
    """Whether a string is a real calendar date, not merely date-shaped.

    ``2026-02-30`` matches the shape and is not a day; letting it through
    made stat report a directory that every later call raised ValueError on.

    Args:
        day (str): the candidate date.
    """
    if not DATE_RE.match(day):
        return False
    try:
        date.fromisoformat(day)
    except ValueError:
        return False
    return True


def slot_instant(slot: dict[str, JsonValue], tz: str) -> datetime | None:
    """Resolve one event time slot to an absolute instant.

    Args:
        slot (dict): an event's ``start`` or ``end`` object.
        tz (str): the bucketing zone, used only for a floating date.

    Returns:
        datetime | None: tz-aware instant, or None when the slot is empty.
    """
    raw = slot.get("dateTime")
    if isinstance(raw, str) and raw:
        try:
            stamp = datetime.fromisoformat(raw)
        except ValueError:
            logger.debug("gcal: invalid event dateTime %r", raw)
            return None
        if stamp.tzinfo is not None:
            return stamp
        # Google requires an offset on dateTime UNLESS the slot names its
        # own zone, so a naive stamp here is a zoned event, not an error.
        # Leaving it naive made it uncomparable with the aware local
        # midnights every bucketing call comes from (TypeError), and using
        # the host zone would silently move the event.
        declared = slot.get("timeZone")
        zone_name = declared if isinstance(declared, str) and declared else tz
        return stamp.replace(tzinfo=zone(zone_name))
    day = slot.get("date")
    if isinstance(day, str) and valid_day(day):
        return local_midnight(day, tz)
    return None


def event_span(
    event: dict[str, JsonValue], tz: str
) -> tuple[datetime, datetime] | None:
    """The absolute [start, end) span of an event.

    An all-day event's ``end.date`` is exclusive, so a one-day event is
    ``start=D, end=D+1`` and its span closes at the midnight opening the
    next day. That is the same convention the instant carries, so no
    adjustment is applied here.

    Args:
        event (dict): an events.list item.
        tz (str): the bucketing zone.

    Returns:
        tuple[datetime, datetime] | None: the span, or None if unparseable.
    """
    start_slot = event.get("start")
    end_slot = event.get("end")
    if not isinstance(start_slot, dict) or not isinstance(end_slot, dict):
        return None
    start = slot_instant(start_slot, tz)
    if start is None:
        return None
    end = slot_instant(end_slot, tz)
    if end is None or end < start:
        end = start
    return start, end


def days_covered(span: tuple[datetime, datetime], tz: str) -> list[str]:
    """Every local day an event's span touches.

    The end is exclusive, so an event closing exactly at local midnight does
    not reach into the following day; a zero-length event still occupies the
    day it starts on.

    Args:
        span (tuple): the (start, end) instants.
        tz (str): the bucketing zone.

    Returns:
        list[str]: ``YYYY-MM-DD`` days in ascending order.
    """
    zi = zone(tz)
    first = span[0].astimezone(zi).date()
    last = span[1].astimezone(zi).date()
    if (
        span[1] > span[0]
        and span[1].astimezone(zi).time() == datetime.min.time()
    ):
        last = last - timedelta(days=1)
    if last < first:
        last = first
    out: list[str] = []
    cur = first
    while cur <= last:
        out.append(cur.isoformat())
        cur = cur + timedelta(days=1)
    return out


def clamped_hhmm(span: tuple[datetime, datetime], day: str, tz: str) -> str:
    """The ``HHMM-HHMM`` label for an event as seen on one local day.

    Times are clamped to the day, so an event running through it reads
    ``0000-2400`` rather than repeating times that belong to another day.
    ``2400`` is how an end at the next local midnight is spelled, since
    ``0000`` there would sort before the start.

    Args:
        span (tuple): the (start, end) instants.
        day (str): the local day being rendered, ``YYYY-MM-DD``.
        tz (str): the bucketing zone.

    Returns:
        str: e.g. ``0900-1030``.
    """
    lo = local_midnight(day, tz)
    hi = local_midnight((lo.date() + timedelta(days=1)).isoformat(), tz)
    zi = zone(tz)
    start = max(span[0], lo).astimezone(zi)
    end = min(span[1], hi).astimezone(zi)
    head = f"{start.hour:02d}{start.minute:02d}"
    if end >= hi:
        return f"{head}-2400"
    return f"{head}-{end.hour:02d}{end.minute:02d}"
