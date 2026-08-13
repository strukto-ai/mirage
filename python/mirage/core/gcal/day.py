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
# The rolling window a bare readdir of a calendar reports. A calendar is
# unbounded in both directions and the API offers no descending startTime
# order, so a full listing means paging to the end; the window is stated in
# the mount prompt rather than applied silently, and any date glob escapes it.
WINDOW_BACK_DAYS = 30
WINDOW_AHEAD_DAYS = 90


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
        logger.debug("gcal: unknown time zone %r, bucketing in %s", tz,
                     DEFAULT_TZ)
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


def day_bounds(day: str, tz: str) -> tuple[str, str]:
    """The RFC3339 timeMin/timeMax pair covering one local day.

    Computed as consecutive local midnights rather than start + 24h: a local
    day is 23 or 25 hours on the two DST transitions each year, and adding a
    fixed day would drop or double an hour of events.

    Args:
        day (str): a floating date, ``YYYY-MM-DD``.
        tz (str): IANA time zone name.

    Returns:
        tuple[str, str]: (timeMin, timeMax) as RFC3339 with offsets.
    """
    start = local_midnight(day, tz)
    nxt = (start.date() + timedelta(days=1)).isoformat()
    return start.isoformat(), local_midnight(nxt, tz).isoformat()


def window_bounds(today: date, tz: str) -> tuple[str, str]:
    """The RFC3339 pair for the default listing window around a day.

    Args:
        today (date): the day the window is centred on.
        tz (str): IANA time zone name.

    Returns:
        tuple[str, str]: (timeMin, timeMax) as RFC3339 with offsets.
    """
    lo = (today - timedelta(days=WINDOW_BACK_DAYS)).isoformat()
    hi = (today + timedelta(days=WINDOW_AHEAD_DAYS)).isoformat()
    return day_bounds(lo, tz)[0], day_bounds(hi, tz)[1]


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


def is_all_day(slot: dict[str, JsonValue]) -> bool:
    """Whether an event time slot is a floating all-day date.

    Args:
        slot (dict): an event's ``start`` or ``end`` object.
    """
    return "date" in slot and "dateTime" not in slot


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
        stamp = datetime.fromisoformat(raw.replace("Z", "+00:00"))
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
    if isinstance(day, str) and DATE_RE.match(day):
        return local_midnight(day, tz)
    return None


def event_span(event: dict[str, JsonValue],
               tz: str) -> tuple[datetime, datetime] | None:
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
    if span[1] > span[0] and span[1].astimezone(
            zi).time() == datetime.min.time():
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
