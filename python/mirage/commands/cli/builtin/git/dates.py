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

import re
import time
from collections.abc import Mapping
from dataclasses import replace
from datetime import datetime, timedelta, timezone

from mirage.commands.builtin.utils.strftime import gnu_strftime
from mirage.commands.cli.builtin.git.errors import (
    DateFormatColonError,
    UnknownDateFormatError,
)
from mirage.commands.cli.builtin.git.types import DateKind, DateMode
from mirage.utils.timezone import zone_from_env

DAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
MONTHS = (
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
)

# git's test clock: when set, the moment relative and human dates count
# from, read as atoi reads it.
NOW_VAR = "GIT_TEST_DATE_NOW"
LEADING_INT = re.compile(r"\s*([+-]?\d+)")

# parse_date_type's table, in its order: each spelling is a prefix, so
# the strict ISO spellings are tried before the plain ones they start
# with.
DATE_SPELLINGS = (
    ("relative", DateKind.RELATIVE),
    ("iso8601-strict", DateKind.ISO8601_STRICT),
    ("iso-strict", DateKind.ISO8601_STRICT),
    ("iso8601", DateKind.ISO8601),
    ("iso", DateKind.ISO8601),
    ("rfc2822", DateKind.RFC2822),
    ("rfc", DateKind.RFC2822),
    ("short", DateKind.SHORT),
    ("default", DateKind.NORMAL),
    ("human", DateKind.HUMAN),
    ("raw", DateKind.RAW),
    ("unix", DateKind.UNIX),
    ("format", DateKind.STRFTIME),
)
AUTO_PREFIX = "auto:"
LOCAL_ALIAS = "local"
LOCAL_SUFFIX = "-local"


def date_clock(env: Mapping[str, str] | None) -> DateMode:
    """The default style, carrying the clock an invocation renders by.

    Args:
        env (Mapping[str, str] | None): the command environment, read for
            ``GIT_TEST_DATE_NOW`` and ``TZ``.
    """
    now = int(time.time())
    if env is not None and NOW_VAR in env:
        found = LEADING_INT.match(env[NOW_VAR])
        now = int(found.group(1)) if found else 0
    return DateMode(now=now, zone=zone_from_env(env))


def parse_date_mode(value: str, clock: DateMode) -> DateMode:
    """Read a ``--date`` value the way git's ``parse_date_format`` does.

    ``auto:<style>`` is the style on a terminal and the default
    anywhere else, and mirage's output is never a terminal. ``local`` is
    the historical spelling of ``default-local``.

    Args:
        value (str): the value as typed.
        clock (DateMode): the invocation's clock, from ``date_clock``.

    Raises:
        UnknownDateFormatError: a style git does not have.
        DateFormatColonError: ``format`` with no ``:``.
    """
    spelled = "default" if value.startswith(AUTO_PREFIX) else value
    if spelled == LOCAL_ALIAS:
        spelled = "default-local"
    for word, kind in DATE_SPELLINGS:
        if spelled.startswith(word):
            rest = spelled[len(word) :]
            break
    else:
        raise UnknownDateFormatError(spelled)
    local = rest.startswith(LOCAL_SUFFIX)
    if local:
        rest = rest[len(LOCAL_SUFFIX) :]
    if kind is DateKind.STRFTIME:
        if not rest.startswith(":"):
            raise DateFormatColonError(spelled)
        return replace(clock, kind=kind, local=local, strftime=rest[1:])
    if rest:
        raise UnknownDateFormatError(spelled)
    return replace(clock, kind=kind, local=local, strftime="")


def zone_text(offset: int) -> str:
    """An offset as git prints one, ``%+05d`` of ``±HHMM``.

    Args:
        offset (int): seconds east of UTC.
    """
    sign = "-" if offset < 0 else "+"
    hours, minutes = divmod(abs(offset) // 60, 60)
    return f"{sign}{hours:02d}{minutes:02d}"


def _local_moment(timestamp: int, mode: DateMode) -> datetime:
    """A moment on the session's clock: its ``TZ``, or the host's zone.

    Args:
        timestamp (int): seconds since the epoch.
        mode (DateMode): carries the zone.
    """
    if mode.zone is None:
        return datetime.fromtimestamp(timestamp).astimezone()
    return datetime.fromtimestamp(timestamp, mode.zone)


def _offset_of(moment: datetime) -> int:
    """Seconds east of UTC a moment is shown at.

    Args:
        moment (datetime): an aware moment.
    """
    delta = moment.utcoffset()
    return int(delta.total_seconds()) if delta is not None else 0


def plural(count: int, unit: str) -> str:
    """``1 day`` or ``2 days``, git's Q_ in the untranslated locale.

    Args:
        count (int): the number.
        unit (str): the singular noun.
    """
    return f"{count} {unit}" if count == 1 else f"{count} {unit}s"


def relative_date(timestamp: int, now: int) -> str:
    """How long before ``now`` a moment was, as ``show_date_relative``
    words it.

    Args:
        timestamp (int): seconds since the epoch.
        now (int): the moment counted from.
    """
    if now < timestamp:
        return "in the future"
    diff = now - timestamp
    if diff < 90:
        return f"{plural(diff, 'second')} ago"
    diff = (diff + 30) // 60
    if diff < 90:
        return f"{plural(diff, 'minute')} ago"
    diff = (diff + 30) // 60
    if diff < 36:
        return f"{plural(diff, 'hour')} ago"
    diff = (diff + 12) // 24
    if diff < 14:
        return f"{plural(diff, 'day')} ago"
    if diff < 70:
        return f"{plural((diff + 3) // 7, 'week')} ago"
    if diff < 365:
        return f"{plural((diff + 15) // 30, 'month')} ago"
    if diff < 1825:
        total = (diff * 12 * 2 + 365) // (365 * 2)
        years, months = divmod(total, 12)
        if months:
            return f"{plural(years, 'year')}, {plural(months, 'month')} ago"
        return f"{plural(years, 'year')} ago"
    return f"{plural((diff + 183) // 365, 'year')} ago"


def _normal(
    timestamp: int, moment: datetime, offset: int, mode: DateMode
) -> str:
    """git's default style, and ``human``, as ``show_date_normal`` lays
    them out.

    ``human`` hides what the reader's own clock already says: the year
    when it is this year, the date when it is this week, the zone when
    it is the reader's, and a moment from today reads as a relative
    one. Without ``human`` nothing is hidden but the zone of a
    ``-local`` date.

    Args:
        timestamp (int): seconds since the epoch.
        moment (datetime): the wall clock to show.
        offset (int): the offset it is shown at, seconds east of UTC.
        mode (DateMode): the style, with its clock.
    """
    human = mode.kind is DateKind.HUMAN
    hide_tz = mode.local
    hide_year = hide_date = hide_wday = hide_time = hide_seconds = False
    if human:
        here = _local_moment(mode.now, mode)
        hide_tz = hide_tz or zone_text(offset) == zone_text(_offset_of(here))
        hide_year = moment.year == here.year
        if hide_year and moment.month == here.month:
            if moment.day == here.day:
                hide_date = hide_wday = True
            elif here.day > moment.day > here.day - 5:
                hide_date = True
        if hide_wday:
            return relative_date(timestamp, mode.now)
        hide_seconds = True
        hide_tz = hide_tz or not hide_date
        hide_wday = hide_time = not hide_year
    out = ""
    if not hide_wday:
        out += f"{DAYS[moment.weekday()]} "
    if not hide_date:
        out += f"{MONTHS[moment.month - 1]} {moment.day} "
    if not hide_time:
        out += f"{moment:%H:%M}"
        if not hide_seconds:
            out += f":{moment:%S}"
    else:
        out = out.rstrip()
    if not hide_year:
        out += f" {moment.year}"
    if not hide_tz:
        out += f" {zone_text(offset)}"
    return out


def _strftime(moment: datetime, offset: int, mode: DateMode) -> str:
    """A ``format:`` date, with ``%z`` and ``%Z`` as git's
    ``strbuf_addftime`` hands them to strftime.

    ``%z`` is the date's own offset rather than the C library's, and
    ``%Z`` is dropped unless the date is shown in the session's zone,
    whose name is the only one strftime can know.

    Args:
        moment (datetime): the wall clock to show.
        offset (int): the offset it is shown at, seconds east of UTC.
        mode (DateMode): the style, with its template.
    """
    template = mode.strftime
    munged: list[str] = []
    i = 0
    while i < len(template):
        char = template[i]
        if char != "%" or i + 1 == len(template):
            munged.append(char)
            i += 1
            continue
        after = template[i + 1]
        if after == "%":
            munged.append("%%")
        elif after == "z":
            munged.append(zone_text(offset))
        elif after == "Z" and not mode.local:
            pass
        else:
            munged.append("%" + after)
        i += 2
    return gnu_strftime(moment, "".join(munged))


def show_date(timestamp: int, offset: int, mode: DateMode) -> str:
    """Render a moment in a git date style, as git's ``show_date`` does.

    The day of the month is never padded in the default style (``Fri
    Jan 16 11:30:00 2026 +0000``), and every style but ``-local`` reads
    the moment in the offset it was recorded with, so a commit prints
    the wall clock its author saw.

    Args:
        timestamp (int): seconds since the epoch.
        offset (int): the recorded UTC offset, seconds east.
        mode (DateMode): the style, with the clock it counts from.
    """
    if mode.kind is DateKind.UNIX:
        return str(timestamp)
    if mode.local:
        moment = _local_moment(timestamp, mode)
        offset = _offset_of(moment)
    else:
        moment = datetime.fromtimestamp(
            timestamp, timezone(timedelta(seconds=offset))
        )
    if mode.kind is DateKind.RAW:
        return f"{timestamp} {zone_text(offset)}"
    if mode.kind is DateKind.RELATIVE:
        return relative_date(timestamp, mode.now)
    if mode.kind is DateKind.SHORT:
        return f"{moment.year:04d}-{moment:%m-%d}"
    if mode.kind is DateKind.ISO8601:
        return f"{moment.year:04d}-{moment:%m-%d %H:%M:%S} {zone_text(offset)}"
    if mode.kind is DateKind.ISO8601_STRICT:
        zone = zone_text(offset)
        return f"{moment.year:04d}-{moment:%m-%dT%H:%M:%S}" + (
            "Z" if offset == 0 else f"{zone[:3]}:{zone[3:]}"
        )
    if mode.kind is DateKind.RFC2822:
        return (
            f"{DAYS[moment.weekday()]}, {moment.day} "
            f"{MONTHS[moment.month - 1]} {moment.year} "
            f"{moment:%H:%M:%S} {zone_text(offset)}"
        )
    if mode.kind is DateKind.STRFTIME:
        return _strftime(moment, offset, mode)
    return _normal(timestamp, moment, offset, mode)
