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

import functools
import logging
import os
import re
import time
import weakref
from bisect import bisect_right, insort
from calendar import timegm
from collections.abc import Mapping
from dataclasses import replace
from datetime import date, datetime, timedelta, timezone, tzinfo
from typing import NamedTuple
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from mirage.commands.builtin.utils.strftime import gnu_strftime, winning_pad
from mirage.commands.cli.builtin.git.errors import (
    DateFormatColonError,
    UnknownDateFormatError,
)
from mirage.commands.cli.builtin.git.types import DateKind, DateMode
from mirage.utils.timezone import (
    posix_transitions,
    resolve_tz,
    zone_from_env,
)

logger = logging.getLogger(__name__)

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
# from; its leading integer is read, and anything else reads as 0.
NOW_VAR = "GIT_TEST_DATE_NOW"
LEADING_INT = re.compile(r"\s*([+-]?\d+)")

# The style names --date takes whole, each also with -local after it
# (git 2.50.1 and 2.47.3 refuse anything longer or shorter, ISO in
# capitals included). `format` instead takes its template after a colon.
STYLE_NAMES = {
    "default": DateKind.NORMAL,
    "relative": DateKind.RELATIVE,
    "short": DateKind.SHORT,
    "iso": DateKind.ISO8601,
    "iso8601": DateKind.ISO8601,
    "iso-strict": DateKind.ISO8601_STRICT,
    "iso8601-strict": DateKind.ISO8601_STRICT,
    "rfc": DateKind.RFC2822,
    "rfc2822": DateKind.RFC2822,
    "human": DateKind.HUMAN,
    "raw": DateKind.RAW,
    "unix": DateKind.UNIX,
}
FORMAT_WORD = "format"
AUTO_PREFIX = "auto:"
LOCAL_ALIAS = "local"
LOCAL_SUFFIX = "-local"
# One strftime directive: flags, width, an E or O modifier, conversion.
DIRECTIVE = re.compile(r"%([-_0^#]*)(\d*)([EO]?)(.?)", re.DOTALL)
# The conversions the C library knows; git leaves any other one as typed
# (git 2.47.3 on glibc prints %q, %N, %+ and %:z literally).
LIBC_CONVERSIONS = frozenset("aAbBcCdDeFgGhHIjklmMnpPrRsStTuUVwWxXyYzZ%")
# The numbers the C library prints, with the digits each fills by
# default; a width pads past them, and `-` drops them (git 2.47.3: `%I`
# is `04`, `%1I` `04`, `%-I` `4` and `%-3I` `  4`).
PADDED_NUMBERS = {
    "C": 2,
    "d": 2,
    "e": 2,
    "g": 2,
    "G": 1,
    "H": 2,
    "I": 2,
    "j": 3,
    "k": 2,
    "l": 2,
    "m": 2,
    "M": 2,
    "S": 2,
    "s": 1,
    "u": 1,
    "U": 2,
    "V": 2,
    "w": 1,
    "W": 2,
    "y": 2,
    "Y": 1,
}
# The numbers it fills with spaces unless `0` says zeros; every other
# number fills with zeros unless `_` or `-` says spaces.
SPACE_FILLED_NUMBERS = frozenset("ekls")
# The zone a date shown at its own offset hands strftime: offset zero,
# named as glibc names it.
GMT = timezone(timedelta(0), "GMT")
# The spans tzdata 2026c marks a zone's lower offset as daylight saving
# time, each with the standard offset in force across it: start, end
# (None for open) and offset, in seconds. Only tzdata's main format says
# so; its rearguard format, which some systems and ICU ship, marks the
# higher offset instead, so the spans are spelled out to read every zone
# the same way on every host.
NEGATIVE_DST: dict[str, tuple[tuple[int, int | None, int], ...]] = {
    "Africa/Casablanca": ((1540692000, 1789866000, 3600),),
    "Africa/El_Aaiun": ((1540692000, 1789866000, 3600),),
    "Africa/Windhoek": ((764200800, 1508796000, 7200),),
    "Eire": ((57722400, None, 3600),),
    "Europe/Dublin": ((57722400, None, 3600),),
}
# The longest step the search for where a tzdata zone's reading changes
# takes, and how far it looks, in seconds. No tzdata 2026c zone holds a
# reading for less than 166 hours after 1970, so a day's step never
# passes one. A POSIX TZ string is read off its rules instead, and the
# host's zone, which nothing bounds, an hour at a time.
STANDARD_SCAN_STEP = 86400
HOST_SCAN_STEP = 3600
STANDARD_SCAN_LIMIT = 800 * 86400
# The UTC years either side of an instant a POSIX TZ string's daylight
# saving windows are laid out over, past STANDARD_SCAN_LIMIT.
POSIX_SCAN_YEARS = 3
# The wall clock from which a zone is read 400 years earlier, the
# searches around it then staying inside the years a datetime holds.
LATE_WALL = timegm((9990, 1, 1, 0, 0, 0))


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
    """Read a ``--date`` value.

    ``auto:<anything>`` is the default style, since it names the style
    for a terminal and mirage's output is never one. ``local`` alone is
    ``default-local``. A value starting ``format`` takes ``-local``
    and then must have its colon; any other must be a style name, with
    or without ``-local``.

    Args:
        value (str): the value as typed.
        clock (DateMode): the invocation's clock, from ``date_clock``.

    Raises:
        UnknownDateFormatError: a style git does not have.
        DateFormatColonError: ``format`` with no ``:``.
    """
    if value.startswith(AUTO_PREFIX):
        return replace(clock, kind=DateKind.NORMAL, local=False, strftime="")
    if value == LOCAL_ALIAS:
        return replace(clock, kind=DateKind.NORMAL, local=True, strftime="")
    if value.startswith(FORMAT_WORD):
        rest = value[len(FORMAT_WORD) :]
        local = rest.startswith(LOCAL_SUFFIX)
        rest = rest[len(LOCAL_SUFFIX) :] if local else rest
        if not rest.startswith(":"):
            raise DateFormatColonError(value)
        return replace(
            clock, kind=DateKind.STRFTIME, local=local, strftime=rest[1:]
        )
    local = value.endswith(LOCAL_SUFFIX)
    name = value[: -len(LOCAL_SUFFIX)] if local else value
    kind = STYLE_NAMES.get(name)
    if kind is None:
        raise UnknownDateFormatError(value)
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
    """How long before ``now`` a moment was, in git's words.

    Seconds count exactly; every larger unit is the one below it rounded
    half up (minutes from seconds, hours from minutes, days from hours,
    then weeks, months and years from days), and the first unit whose
    count stays under its limit is the one shown: seconds under 90,
    minutes under 90, hours under 36, days under 14, weeks while under
    70 days and months while under 365. Up to five years the months
    left over follow the years. Measured against git 2.50.1 and 2.47.3
    at every second of the first two days and of every transition up to
    40 years: 90 s is ``2 minutes ago``, 89.5 minutes ``2 hours ago``.

    Args:
        timestamp (int): the moment, in epoch seconds.
        now (int): the moment counted from.
    """
    elapsed = now - timestamp
    if elapsed < 0:
        return "in the future"
    if elapsed < 90:
        return f"{plural(elapsed, 'second')} ago"
    minutes = (elapsed + 30) // 60
    if minutes < 90:
        return f"{plural(minutes, 'minute')} ago"
    hours = (minutes + 30) // 60
    if hours < 36:
        return f"{plural(hours, 'hour')} ago"
    days = (hours + 12) // 24
    if days < 14:
        return f"{plural(days, 'day')} ago"
    if days < 70:
        return f"{plural((days + 3) // 7, 'week')} ago"
    if days < 365:
        return f"{plural((days + 15) // 30, 'month')} ago"
    if days >= 5 * 365:
        return f"{plural((days + 183) // 365, 'year')} ago"
    years, months = divmod((days * 24 + 365) // 730, 12)
    if not months:
        return f"{plural(years, 'year')} ago"
    return f"{plural(years, 'year')}, {plural(months, 'month')} ago"


class DaylightStretch(NamedTuple):
    """A stretch of one daylight saving reading in a zone, and the
    standard time nearest it on either side.

    Args:
        start (int): its first instant, epoch seconds.
        end (int): the first instant after it.
        offset (int): its offset, seconds east of UTC.
        before (tuple[int, int] | None): the last instant of the
            standard time before it and that time's offset, None when
            none lies within STANDARD_SCAN_LIMIT.
        after (tuple[int, int] | None): the first instant of the
            standard time after it and that time's offset.
    """

    start: int
    end: int
    offset: int
    before: tuple[int, int] | None
    after: tuple[int, int] | None


# The daylight saving stretches found so far, per zone, sorted by start,
# so a later date in one costs a lookup; the host's zone, which has no
# tzinfo to key by, under its names.
STRETCHES: weakref.WeakKeyDictionary[tzinfo, list[DaylightStretch]] = (
    weakref.WeakKeyDictionary()
)
HOST_STRETCHES: dict[tuple[str, ...], list[DaylightStretch]] = {}


class Wall(NamedTuple):
    """A moment as a clock on the wall reads it."""

    year: int
    month: int
    day: int
    hour: int
    minute: int
    second: int
    weekday: int  # 0 for Monday


def _fixed_wall(timestamp: int, offset: int) -> Wall:
    """The wall clock a fixed offset shows, past year 9999 too: the
    Gregorian calendar repeats its dates and weekdays every 400 years
    (146097 days), so a later day is read that many cycles earlier.

    Args:
        timestamp (int): seconds since the epoch.
        offset (int): seconds east of UTC.
    """
    days, seconds = divmod(timestamp + offset, 86400)
    ordinal = date(1970, 1, 1).toordinal() + days
    cycles = max(0, -((date.max.toordinal() - ordinal) // 146097))
    day = date.fromordinal(ordinal - cycles * 146097)
    hour, rest = divmod(seconds, 3600)
    return Wall(
        day.year + cycles * 400,
        day.month,
        day.day,
        hour,
        rest // 60,
        rest % 60,
        day.weekday(),
    )


def _bare_epoch(timestamp: int, year: int, offset: int, mode: DateMode) -> str:
    """What git prints for a bare ``%s``: the instant while the shown wall
    clock is in the years 1970 to 2099, and outside them -1 as an unsigned
    64-bit number, less the date's own offset unless ``-local`` (git
    2.47.3 and 2.50.1: ``4102444800 +0530``, 2100-01-01 05:30 there,
    prints ``18446744073709531815``, and ``253402300799 -1200``
    ``43199``).

    Args:
        timestamp (int): seconds since the epoch.
        year (int): the year of the shown wall clock.
        offset (int): the date's own offset, seconds east of UTC.
        mode (DateMode): carries ``local``.
    """
    if 1970 <= year <= 2099:
        return str(timestamp)
    return str((-1 - (0 if mode.local else offset)) % 2**64)


def _in_range(timestamp: int) -> int:
    """The same moment whole 400-year cycles earlier when it is late
    enough that a ``datetime`` could not hold it at every offset.

    Args:
        timestamp (int): seconds since the epoch.
    """
    cycle = 146097 * 86400
    # A day short of the last second a datetime holds.
    last = (date.max - date(1970, 1, 1)).days * 86400 - 86400
    return timestamp - max(0, -((last - timestamp) // cycle)) * cycle


def _shown(timestamp: int, offset: int, mode: DateMode) -> tuple[Wall, int]:
    """The wall clock a style shows and the offset it is at: the date's
    own, or with ``-local`` the session's.

    Args:
        timestamp (int): seconds since the epoch.
        offset (int): the date's own offset, seconds east of UTC.
        mode (DateMode): carries ``local`` and the session's zone.
    """
    if mode.local:
        offset = _offset_of(_local_moment(_in_range(timestamp), mode))
    return _fixed_wall(timestamp, offset), offset


def _human(timestamp: int, offset: int, mode: DateMode) -> str:
    """The human style: only what the reader cannot tell from now.

    git 2.50.1 and 2.47.3, measured over 3.6 million dates against six
    clocks in six zones: a date on today's day is relative, one in
    another year is ``Jan 5 2026``, one to four days back in this month
    is the weekday and time, followed by the date's offset when it is
    not the session's own, and any other is ``Mon Jan 5 09:05``. The
    date's day is read at its own offset (the session's with ``-local``,
    which never adds an offset) and today's in the session's zone.

    Args:
        timestamp (int): seconds since the epoch.
        offset (int): the date's own offset, seconds east of UTC.
        mode (DateMode): carries the clock and the zone.
    """
    today = _local_moment(mode.now, mode)
    wall, offset = _shown(timestamp, offset, mode)
    if (wall.year, wall.month, wall.day) == (
        today.year,
        today.month,
        today.day,
    ):
        return relative_date(timestamp, mode.now)
    if wall.year != today.year:
        return f"{MONTHS[wall.month - 1]} {wall.day} {wall.year}"
    clock = f"{wall.hour:02d}:{wall.minute:02d}"
    if wall.month == today.month and 0 < today.day - wall.day < 5:
        zone = (
            ""
            if mode.local or offset == _offset_of(today)
            else f" {zone_text(offset)}"
        )
        return f"{DAYS[wall.weekday]} {clock}{zone}"
    return f"{DAYS[wall.weekday]} {MONTHS[wall.month - 1]} {wall.day} {clock}"


def _formatted(timestamp: int, offset: int, mode: DateMode) -> str:
    """A ``format:`` template, as git hands it to the C library.

    git answers a bare ``%s`` (the instant), ``%z`` (the shown offset)
    and ``%Z`` (empty, or the session zone's name with ``-local``)
    itself, and ``%%`` stays a percent sign. Everything else goes to
    strftime over the shown wall clock, at offset zero named ``GMT``
    unless ``-local``, which is why glibc's ``%#Z`` reads ``gmt``; a
    conversion the C library lacks, and a ``%`` that ends the template,
    stay as typed.

    Args:
        timestamp (int): seconds since the epoch.
        offset (int): the date's own offset, seconds east of UTC.
        mode (DateMode): carries the template, ``local`` and the zone.
    """
    # Late enough, the moment is held whole Gregorian cycles earlier, and
    # the years they span go back into every directive that prints one.
    held = _in_range(timestamp)
    years = (timestamp - held) // (146097 * 86400) * 400
    if mode.local:
        moment = _local_moment(held, mode)
        offset = _offset_of(moment)
    else:
        moment = datetime.fromtimestamp(held + offset, GMT)
    out: list[str] = []
    at = 0
    for found in DIRECTIVE.finditer(mode.strftime):
        out.append(mode.strftime[at : found.start()])
        at = found.end()
        flags, width, modifier, conversion = found.groups()
        bare = not (flags or width or modifier)
        if bare and conversion == "s":
            out.append(
                _bare_epoch(timestamp, moment.year + years, offset, mode)
            )
        elif bare and conversion == "z":
            out.append(zone_text(offset))
        elif bare and conversion == "Z":
            out.append((moment.tzname() or "") if mode.local else "")
        elif bare and conversion == "%":
            out.append("%")
        elif conversion not in LIBC_CONVERSIONS:
            out.append(found.group(0))
        elif conversion == "z":
            out.append(_libc_zone(_offset_of(moment), flags, int(width or 0)))
        else:
            text = (
                str(
                    _wall_as_standard(
                        timestamp, moment, mode, timestamp - held
                    )
                )
                if conversion == "s"
                else _conversion_text(moment, conversion, years)
            )
            out.append(
                _padded_conversion(text, conversion, flags, int(width or 0))
            )
    out.append(mode.strftime[at:])
    return "".join(out)


def _conversion_text(moment: datetime, conversion: str, years: int) -> str:
    """One conversion over the shown wall clock, unpadded: a number's
    digits alone, and ``%F`` with its year unsigned past 9999 where GNU
    date signs it (git 2.47.3: ``10000-01-01``).

    Args:
        moment (datetime): the shown wall clock.
        conversion (str): the conversion letter.
        years (int): years the moment is held earlier than it shows.
    """
    if conversion in PADDED_NUMBERS:
        return gnu_strftime(moment, f"%-{conversion}", years)
    if conversion == "F":
        return gnu_strftime(moment, "%Y-%m-%d", years)
    literal = {"n": "\n", "t": "\t", "%": "%"}.get(conversion)
    if literal is not None:
        return literal
    return gnu_strftime(moment, f"%{conversion}", years)


def _padded_conversion(
    text: str, conversion: str, flags: str, width: int
) -> str:
    """A conversion's text cased and padded as the C library does, git
    2.47.3 measured over every conversion under 22 flag sets and 6
    widths: the last of ``_``, ``-`` and ``0`` typed decides the padding
    (``%0_12s`` is spaces, ``%_012s`` zeros). ``#`` upcases a day or
    month name and lowers ``%p`` and ``%Z``; otherwise ``^`` upcases
    anything but ``%P``. A width pads text and the composites with
    spaces unless ``0`` is the padding, even under ``-``.

    Args:
        text (str): the conversion's text, a number's digits unpadded.
        conversion (str): the conversion letter.
        flags (str): the directive's flags.
        width (int): its width, 0 for none.
    """
    if "#" in flags and conversion in "aAbBh":
        text = text.upper()
    elif "#" in flags and conversion in "pZ":
        text = text.lower()
    elif "^" in flags and conversion != "P":
        text = text.upper()
    pad = winning_pad(flags)
    if conversion in PADDED_NUMBERS:
        digits = 0 if pad == "-" else PADDED_NUMBERS[conversion]
        spaced = pad in ("_", "-") or (
            pad is None and conversion in SPACE_FILLED_NUMBERS
        )
        return text.rjust(max(digits, width), " " if spaced else "0")
    return text.rjust(width, "0" if pad == "0" else " ")


@functools.cache
def _host_zone(tz: str | None) -> tzinfo | None:
    """The host's zone, as its name gives it: the ``TZ`` the process runs
    under, read as a session's would be, else the tzdata zone
    /etc/localtime links to; None when neither names one.

    Args:
        tz (str | None): the process's ``TZ``, None when unset.
    """
    if tz is not None:
        return resolve_tz(tz)
    _, marker, key = os.path.realpath("/etc/localtime").partition("/zoneinfo/")
    if not marker:
        return None
    try:
        return ZoneInfo(key)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        logger.debug("host zone %r is not a tzdata zone: %s", key, exc)
        return None


def _session_zone(mode: DateMode) -> tzinfo | None:
    """The zone a session reads its dates in: its ``TZ``'s, else the
    host's when it can be named, None for a host zone only the C library
    knows.

    Args:
        mode (DateMode): carries the session's zone, None for the host's.
    """
    if mode.zone is not None:
        return mode.zone
    return _host_zone(os.environ.get("TZ"))


def _zone_reading(instant: int, mode: DateMode) -> tuple[int, bool]:
    """The session zone's offset at an instant, and whether tzdata calls
    it standard time there.

    Args:
        instant (int): seconds since the epoch.
        mode (DateMode): carries the session's zone, None for the host's.
    """
    zone = _session_zone(mode)
    if zone is None:
        local = time.localtime(instant)
        return local.tm_gmtoff, local.tm_isdst <= 0
    moment = datetime.fromtimestamp(instant, zone)
    offset = _offset_of(moment)
    name = zone.key if isinstance(zone, ZoneInfo) else ""
    for start, end, standard in NEGATIVE_DST.get(name, ()):
        if start <= instant and (end is None or instant < end):
            return offset, offset == standard
    return offset, not moment.dst()


def _reading_edge(
    instant: int, direction: int, reading: tuple[int, bool], mode: DateMode
) -> int | None:
    """Where the zone's reading at an instant changes: the first instant
    of the stretch holding it (``direction`` -1) or the first after it
    (+1), found by doubling steps up to STANDARD_SCAN_STEP and then
    halving the last one down to the second; None when the reading holds
    past STANDARD_SCAN_LIMIT.

    Args:
        instant (int): seconds since the epoch.
        direction (int): -1 to look back, 1 to look ahead.
        reading (tuple[int, bool]): the zone's reading at ``instant``.
        mode (DateMode): carries the session's zone.
    """
    longest = (
        STANDARD_SCAN_STEP
        if isinstance(_session_zone(mode), ZoneInfo)
        else HOST_SCAN_STEP
    )
    same = instant
    step = 3600
    while abs(same - instant) < STANDARD_SCAN_LIMIT:
        probe = same + direction * step
        if _zone_reading(probe, mode) != reading:
            while abs(probe - same) > 1:
                middle = (same + probe) // 2
                if _zone_reading(middle, mode) == reading:
                    same = middle
                else:
                    probe = middle
            return same if direction < 0 else probe
        same = probe
        step = min(2 * step, longest)
    return None


def _posix_stretch(
    instant: int, offset: int, mode: DateMode
) -> DaylightStretch | None:
    """The daylight saving stretch holding an instant in a zone given as
    a POSIX TZ string, read off its rules: each UTC year's window from
    the instant its start rule lays out to the one its end rule does,
    wrapping the year when the end comes first, merged across years.
    None for a zone of any other kind.

    Args:
        instant (int): seconds since the epoch, in daylight saving time.
        offset (int): the zone's offset then, seconds east of UTC.
        mode (DateMode): carries the session's zone.
    """
    zone = _session_zone(mode)
    if zone is None:
        return None
    year = datetime.fromtimestamp(instant, timezone.utc).year
    first, last = year - POSIX_SCAN_YEARS, year + POSIX_SCAN_YEARS
    windows: list[list[int]] = []
    for each in range(first, last + 1):
        laid = posix_transitions(zone, each)
        if laid is None:
            return None
        start, end = laid
        opens = timegm((each, 1, 1, 0, 0, 0))
        closes = timegm((each + 1, 1, 1, 0, 0, 0))
        pieces = (
            [(start, end)] if start <= end else [(opens, end), (start, closes)]
        )
        for begin, finish in pieces:
            begin, finish = max(begin, opens), min(finish, closes)
            if begin >= finish:
                continue
            if windows and windows[-1][1] >= begin:
                windows[-1][1] = max(windows[-1][1], finish)
            else:
                windows.append([begin, finish])
    low = timegm((first, 1, 1, 0, 0, 0))
    high = timegm((last + 1, 1, 1, 0, 0, 0))
    for start, end in windows:
        if start <= instant < end:
            before = start - 1
            return DaylightStretch(
                start,
                end,
                offset,
                None
                if start <= low
                else (before, _zone_reading(before, mode)[0]),
                None if end >= high else (end, _zone_reading(end, mode)[0]),
            )
    return DaylightStretch(instant, instant + 1, offset, None, None)


def _standard_beyond(
    edge: int, direction: int, mode: DateMode
) -> tuple[int, int] | None:
    """The standard time nearest an edge, walking on past any other
    daylight saving stretch next to it: the instant where it meets the
    edge's side and its offset, None when none lies within reach.

    Args:
        edge (int): the first instant outside a stretch on this side.
        direction (int): -1 to look back, 1 to look ahead.
        mode (DateMode): carries the session's zone.
    """
    at: int | None = edge
    while at is not None and abs(at - edge) < STANDARD_SCAN_LIMIT:
        reading = _zone_reading(at, mode)
        if reading[1]:
            return at, reading[0]
        far = _reading_edge(at, direction, reading, mode)
        at = None if far is None else far - 1 if direction < 0 else far
    return None


def _stretches_of(mode: DateMode) -> list[DaylightStretch]:
    """The daylight saving stretches found so far in the session's zone.

    Args:
        mode (DateMode): carries the session's zone, None for the host's.
    """
    zone = _session_zone(mode)
    if zone is None:
        return HOST_STRETCHES.setdefault(tuple(time.tzname), [])
    try:
        return STRETCHES.setdefault(zone, [])
    except TypeError:
        # A fixed offset (datetime.timezone) cannot be weakly keyed, and
        # has no daylight saving time to search.
        return []


def _standard_offset(instant: int, mode: DateMode) -> int:
    """The standard offset nearest an instant in the session's zone: its
    own where tzdata calls it standard time, else that of the standard
    time nearer to it, before or after. Measured on git 2.47.3 over 20
    zones and 2,376 dates each, among them Europe/Dublin, whose standard
    time is IST and whose GMT winter is negative daylight saving time,
    Africa/Casablanca since 2018, Africa/Windhoek from 1994 to 2017,
    Australia/Lord_Howe's half hour and the southern hemisphere. A
    daylight saving stretch is searched once per zone and kept.

    Args:
        instant (int): seconds since the epoch.
        mode (DateMode): carries the session's zone.
    """
    stretches = _stretches_of(mode)
    at = bisect_right(stretches, instant, key=lambda found: found.start) - 1
    if at >= 0 and instant < stretches[at].end:
        stretch = stretches[at]
    else:
        reading = _zone_reading(instant, mode)
        if reading[1]:
            return reading[0]
        found = _posix_stretch(instant, reading[0], mode)
        if found is None:
            start = _reading_edge(instant, -1, reading, mode)
            end = _reading_edge(instant, 1, reading, mode)
            found = DaylightStretch(
                instant if start is None else start,
                instant + 1 if end is None else end,
                reading[0],
                None
                if start is None
                else _standard_beyond(start - 1, -1, mode),
                None if end is None else _standard_beyond(end, 1, mode),
            )
        stretch = found
        if stretch.before is not None and stretch.after is not None:
            insort(stretches, stretch, key=lambda kept: kept.start)
    before, after = stretch.before, stretch.after
    if before is not None and (
        after is None or instant - before[0] <= after[0] - instant
    ):
        return before[1]
    return stretch.offset if after is None else after[1]


def _wall_as_standard(
    timestamp: int, moment: datetime, mode: DateMode, moved: int
) -> int:
    """What a ``%s`` that carries a flag, a width or a modifier prints.
    With ``-local`` that is the instant; otherwise the date's own wall
    clock read back as standard time in the session's zone, so it moves
    by the difference (git 2.47.3, ``TZ=UTC``: ``999999999 -0930``
    prints ``999965799``; in New York it counts EST all year, and in
    Dublin IST).

    Args:
        timestamp (int): seconds since the epoch.
        moment (datetime): the shown wall clock.
        mode (DateMode): carries ``local`` and the session's zone.
        moved (int): how many seconds earlier ``moment`` is held than
            the date it shows.
    """
    if mode.local:
        return timestamp
    wall = timegm(moment.timetuple())
    # A datetime holds no year past 9999, so from LATE_WALL on the zone is
    # read a Gregorian cycle earlier, which every rule past 2037 repeats.
    reading = wall - 146097 * 86400 if wall >= LATE_WALL else wall
    return wall - _standard_offset(reading, mode) + moved


def _libc_zone(offset: int, flags: str, width: int) -> str:
    """What glibc prints for a ``%z`` that carries a flag, a width or a
    modifier, from the offset its wall clock carries: zero for a date
    shown at its own offset, the session's with ``-local``.

    The width pads twice, in front of the sign and inside the ``hhmm``
    number, which keeps four digits unless ``-`` drops them, and the
    last of ``_``, ``-`` and ``0`` typed decides both (git 2.47.3:
    ``%5z`` is ``    +00000``, ``%05z`` ``0000+00000``, ``%_z``
    ``+   0``, ``%-z`` ``+0`` and ``%0_3z`` ``  +   0``).

    Args:
        offset (int): seconds east of UTC.
        flags (str): the directive's flags.
        width (int): its width, 0 for none.
    """
    sign = "-" if offset < 0 else "+"
    hours, minutes = divmod(abs(offset) // 60, 60)
    number = str(hours * 100 + minutes)
    pad = winning_pad(flags)
    lead = ("0" if pad == "0" else " ") * max(0, width - 1)
    if pad == "-":
        return f"{lead}{sign}{number.rjust(width)}"
    fill = " " if pad == "_" else "0"
    return f"{lead}{sign}{number.rjust(max(4, width), fill)}"


def show_date(timestamp: int, offset: int, mode: DateMode) -> str:
    """A date as ``--date`` renders it.

    ``default`` is ``Mon Jan 5 09:05:00 2026 +0000`` (the day unpadded,
    no offset with ``-local``), ``iso`` is ``2026-01-05 09:05:00
    +0000``, ``iso-strict`` ``2026-01-05T09:05:00+00:00`` with ``Z`` for
    a zero offset, ``rfc`` ``Mon, 5 Jan 2026 09:05:00 +0000``, ``short``
    the date alone, ``raw`` the instant and the shown offset, and
    ``unix`` and ``relative`` the instant whatever ``-local`` says.

    Args:
        timestamp (int): seconds since the epoch.
        offset (int): the date's own offset, seconds east of UTC.
        mode (DateMode): the style, with its clock and zone.
    """
    kind = mode.kind
    if kind is DateKind.UNIX:
        return str(timestamp)
    if kind is DateKind.RELATIVE:
        return relative_date(timestamp, mode.now)
    if kind is DateKind.HUMAN:
        return _human(timestamp, offset, mode)
    if kind is DateKind.STRFTIME:
        return _formatted(timestamp, offset, mode)
    wall, offset = _shown(timestamp, offset, mode)
    if kind is DateKind.RAW:
        return f"{timestamp} {zone_text(offset)}"
    day = f"{wall.year:04d}-{wall.month:02d}-{wall.day:02d}"
    if kind is DateKind.SHORT:
        return day
    clock = f"{wall.hour:02d}:{wall.minute:02d}:{wall.second:02d}"
    weekday, month = DAYS[wall.weekday], MONTHS[wall.month - 1]
    if kind is DateKind.ISO8601:
        return f"{day} {clock} {zone_text(offset)}"
    if kind is DateKind.ISO8601_STRICT:
        zone = zone_text(offset)
        return (
            f"{day}T{clock}{'Z' if not offset else zone[:3] + ':' + zone[3:]}"
        )
    if kind is DateKind.RFC2822:
        return (
            f"{weekday}, {wall.day} {month} {wall.year} {clock} "
            f"{zone_text(offset)}"
        )
    text = f"{weekday} {month} {wall.day} {clock} {wall.year}"
    return text if mode.local else f"{text} {zone_text(offset)}"
