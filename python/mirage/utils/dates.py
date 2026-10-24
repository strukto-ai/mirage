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

import math
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone, tzinfo

from mirage.utils.timezone import posix_transitions, resolve_tz

_POSIX_TIME_RE = re.compile(r"([0-9]{8}|[0-9]{10}|[0-9]{12})(\.[0-9]{2})?")

# The moments mirage holds, as Python's datetime does: 0001-01-01 00:00:00
# to 9999-12-31 23:59:59 UTC.
_FIRST_SECOND = -62135596800
_LAST_SECOND = 253402300799
_DAY = 86400
_NANOS = 1_000_000_000
# date reads each number, and keeps each relative count, in a signed 64-bit
# integer, refusing one that overflows it.
_INT64 = 1 << 63

_BLANKS = " \t\n\v\f\r"
_DIGITS = "0123456789"
_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
_SIGNS = "+-"

_MONTHS = (
    "JANUARY",
    "FEBRUARY",
    "MARCH",
    "APRIL",
    "MAY",
    "JUNE",
    "JULY",
    "AUGUST",
    "SEPTEMBER",
    "OCTOBER",
    "NOVEMBER",
    "DECEMBER",
)
_WEEKDAYS = (
    "SUNDAY",
    "MONDAY",
    "TUESDAY",
    "WEDNESDAY",
    "THURSDAY",
    "FRIDAY",
    "SATURDAY",
)
# Longer abbreviations date reads beside the three-letter ones.
_NAMED_DAYS = {
    "SEPT": ("month", 9),
    "TUES": ("weekday", 2),
    "WEDNES": ("weekday", 3),
}
_NAMED_DAYS |= {"THUR": ("weekday", 4), "THURS": ("weekday", 4)}
# (kind, amount): a unit counts months, days or seconds.
_UNITS = {
    "YEAR": ("months", 12),
    "MONTH": ("months", 1),
    "FORTNIGHT": ("days", 14),
    "WEEK": ("days", 7),
    "DAY": ("days", 1),
    "HOUR": ("seconds", 3600),
    "MINUTE": ("seconds", 60),
    "MIN": ("seconds", 60),
    "SECOND": ("seconds", 1),
    "SEC": ("seconds", 1),
}
_DAY_WORDS = {"TOMORROW": 1, "YESTERDAY": -1, "TODAY": 0, "NOW": 0}
# "SECOND" is the unit, so the second ordinal has no word.
_ORDINALS = {"LAST": -1, "THIS": 0, "NEXT": 1, "FIRST": 1, "THIRD": 3}
_ORDINALS |= {"FOURTH": 4, "FIFTH": 5, "SIXTH": 6, "SEVENTH": 7, "EIGHTH": 8}
_ORDINALS |= {"NINTH": 9, "TENTH": 10, "ELEVENTH": 11, "TWELFTH": 12}
_SUFFIXES = {"AGO": -1, "HENCE": 1}
_MERIDIANS = {"AM": 0, "A.M.": 0, "PM": 12, "P.M.": 12}
# The zone names date accepts, measured on coreutils 9.7, each at its UTC
# offset in minutes as tzdata and RFC 5322 give it (SST is read at -12:00).
# The second set names daylight time, which takes no "DST" and no offset
# after it.
_STANDARD_ZONES = {
    "UT": 0,
    "UTC": 0,
    "GMT": 0,
    "WET": 0,
    "WAT": 60,
    "CET": 60,
    "MET": 60,
    "MEZ": 60,
    "EET": 120,
    "CAT": 120,
    "SAST": 120,
    "EAT": 180,
    "MSK": 180,
    "IST": 330,
    "SGT": 480,
    "KST": 540,
    "JST": 540,
    "GST": 600,
    "NZST": 720,
    "ART": -180,
    "BRT": -180,
    "NST": -210,
    "AST": -240,
    "CLT": -240,
    "EST": -300,
    "CST": -360,
    "MST": -420,
    "PST": -480,
    "AKST": -540,
    "HST": -600,
    "HAST": -600,
    "SST": -720,
}
_DAYLIGHT_ZONES = {
    "WEST": 60,
    "BST": 60,
    "CEST": 120,
    "MEST": 120,
    "MESZ": 120,
    "EEST": 180,
    "MSD": 240,
    "NZDT": 780,
    "BRST": -120,
    "NDT": -150,
    "ADT": -180,
    "CLST": -180,
    "EDT": -240,
    "CDT": -300,
    "MDT": -360,
    "PDT": -420,
    "AKDT": -480,
    "HADT": -540,
}
# A zone correction reaches a whole day either way.
_ZONE_LIMIT = 24 * 60
_UNIT_KINDS = ("months", "days", "seconds")
# Names the zone's own abbreviations never stand in for.
_FIXED_NAMES = ("GMT", "UT", "UTC")


class _NotADate(Exception):
    """A date expression date would answer with ``invalid date``."""


@dataclass(frozen=True)
class _Token:
    """One lexeme of a date expression.

    A number keeps its digits as typed, the sign that led it (``""`` for
    none) and, after a ``.`` or ``,``, its fraction in nanoseconds; a word
    is upper-cased, dots kept; anything else is a single character.
    """

    kind: str
    text: str
    sign: str = ""
    value: int = 0
    nanos: int | None = None


def _military(letter: str) -> int:
    """Minutes east of UTC for a military zone letter, J excluded.

    Args:
        letter (str): one upper-case letter.
    """
    if letter == "Z":
        return 0
    if letter < "J":
        return (ord(letter) - ord("A") + 1) * 60
    if letter < "N":
        return (ord(letter) - ord("A")) * 60
    return -(ord(letter) - ord("N") + 1) * 60


def _meaning(word: str) -> tuple[str, int] | None:
    """What an upper-cased word names, as ``(kind, value)``.

    Kinds: ``meridian`` (hours to add), ``month`` (1-12), ``weekday``
    (0 is Sunday), ``dst``, a unit (``months``/``days``/``seconds`` with
    its size), ``today`` (and its neighbours, in days), ``ordinal``,
    ``suffix`` (ago, hence), ``zone`` and ``daylight`` (minutes east) and
    ``local`` (J, the zone the expression is read in).

    Args:
        word (str): the word, upper-cased, dots kept.
    """
    if word in _MERIDIANS:
        return "meridian", _MERIDIANS[word]
    if word in _MONTHS:
        return "month", _MONTHS.index(word) + 1
    if word in _WEEKDAYS:
        return "weekday", _WEEKDAYS.index(word)
    if word in _NAMED_DAYS:
        return _NAMED_DAYS[word]
    short = (
        word[:3]
        if len(word) == 3 or (len(word) == 4 and word[3] == ".")
        else ""
    )
    if short.isalpha():
        for at, name in enumerate(_MONTHS):
            if name.startswith(short):
                return "month", at + 1
        for at, name in enumerate(_WEEKDAYS):
            if name.startswith(short):
                return "weekday", at
    if word == "DST":
        return "dst", 0
    for unit in (word, word[:-1] if word.endswith("S") else ""):
        if unit in _UNITS:
            return _UNITS[unit]
    if word in _DAY_WORDS:
        return "today", _DAY_WORDS[word]
    if word in _ORDINALS:
        return "ordinal", _ORDINALS[word]
    if word in _SUFFIXES:
        return "suffix", _SUFFIXES[word]
    bare = word.replace(".", "")
    if bare in _STANDARD_ZONES and len(bare) > 1:
        return "zone", _STANDARD_ZONES[bare]
    if bare in _DAYLIGHT_ZONES:
        return "daylight", _DAYLIGHT_ZONES[bare]
    if len(word) == 1:
        return ("local", 0) if word == "J" else ("zone", _military(word))
    return None


def _bare_token(kind: str, text: str) -> _Token:
    """A word or a character, which carries no number."""
    return _Token(kind, text)


def _lex_number(text: str, at: int, sign: str) -> tuple[_Token, int]:
    """The number whose digits start at ``at``, and where it ends.

    Args:
        text (str): the expression.
        at (int): the first digit.
        sign (str): the sign that led it, or ``""``.
    """
    stop = at
    while stop < len(text) and text[stop] in _DIGITS:
        stop += 1
    digits = text[at:stop]
    nanos = None
    if (
        stop + 1 < len(text)
        and text[stop] in ".,"
        and text[stop + 1] in _DIGITS
    ):
        end = stop + 1
        while end < len(text) and text[end] in _DIGITS:
            end += 1
        fraction = text[stop + 1 : end]
        # Nanoseconds are all date keeps; further digits are dropped,
        # though a negative number's nonzero ones still take it one
        # nanosecond further down.
        nanos = int(fraction[:9].ljust(9, "0"))
        if sign == "-" and fraction[9:].strip("0"):
            nanos += 1
        stop = end
    size = int(digits)
    if size >= _INT64:
        raise _NotADate
    value = -size if sign == "-" else size
    return _Token("number", digits, sign, value, nanos), stop


def _lex(text: str) -> list[_Token]:
    """Split a date expression into tokens.

    White space and parenthesized comments (which nest, and run to the end
    when unclosed) separate tokens. A run of signs and blanks before digits
    signs the number with its last sign; one before anything else is
    dropped.

    Args:
        text (str): the expression, after any ``TZ="..."`` prefix.
    """
    tokens: list[_Token] = []
    at = 0
    while at < len(text):
        char = text[at]
        if char in _BLANKS:
            at += 1
        elif char == "(":
            depth = 0
            while at < len(text):
                depth += {"(": 1, ")": -1}.get(text[at], 0)
                at += 1
                if depth == 0:
                    break
        elif char in _SIGNS:
            sign, probe = char, at + 1
            while probe < len(text) and text[probe] in _SIGNS + _BLANKS:
                if text[probe] in _SIGNS:
                    sign = text[probe]
                probe += 1
            if probe < len(text) and text[probe] in _DIGITS:
                token, at = _lex_number(text, probe, sign)
                tokens.append(token)
            else:
                at = probe
        elif char in _DIGITS:
            token, at = _lex_number(text, at, "")
            tokens.append(token)
        elif char in _LETTERS:
            stop = at
            while stop < len(text) and (
                text[stop] in _LETTERS or text[stop] == "."
            ):
                stop += 1
            tokens.append(_bare_token("word", text[at:stop].upper()))
            at = stop
        else:
            tokens.append(_bare_token("char", char))
            at += 1
    return tokens


def _unit(token: _Token) -> tuple[str, int]:
    """The kind and size of a unit word the parser looked at.

    Args:
        token (_Token): the word.
    """
    meaning = _meaning(token.text)
    if meaning is None:
        raise _NotADate
    return meaning


def _year_of(token: _Token) -> int:
    """A year as typed: two digits are 1969-2068, any other count is literal.

    Args:
        token (_Token): the number.
    """
    year = abs(token.value)
    if len(token.text) == 2:
        return year + (2000 if year < 69 else 1900)
    return year


@dataclass
class _Reading:
    """What a date expression names, before it is placed in time.

    ``date`` is ``(year, month, day)`` with no year until one is given;
    ``clock`` is ``(hour, minute, second, nanos)``; ``zone`` is seconds
    east, None with ``zoned`` set for J or a name of the zone the
    expression is read in, which sets ``named``, and ``dst`` to whether it
    names daylight time (None for a name both seasons use); ``weekday`` is
    ``(ordinal, day)``; the relative items sum into ``months``, ``days``,
    ``seconds`` and ``nanos``, the fractions of a second, and ``counts``
    holds each unit's own count, by kind and size, a week's and a
    fortnight's as days.
    """

    date: tuple[int | None, int, int] | None = None
    clock: tuple[int, int, int, int] | None = None
    zone: int | None = None
    zoned: bool = False
    named: bool = False
    dst: bool | None = None
    weekday: tuple[int, int] | None = None
    months: int = 0
    days: int = 0
    seconds: int = 0
    nanos: int = 0
    counts: dict[tuple[str, int], int] = field(default_factory=dict)
    relative: bool = False
    epoch: tuple[int, int] | None = None


class _Parser:
    """Reads the items of a tokenized date expression into a ``_Reading``.

    Each date, time of day, zone and day of the week may appear once;
    relative items add up. Every refusal raises ``_NotADate``.
    """

    def __init__(
        self, tokens: list[_Token], names: dict[str, bool | None]
    ) -> None:
        self.tokens = tokens
        self.names = names
        self.at = 0
        self.reading = _Reading()
        # Where the last ISO date ended, for the "T" that may follow it.
        self.iso_end = -1

    def peek(self, ahead: int = 0) -> _Token | None:
        at = self.at + ahead
        return self.tokens[at] if at < len(self.tokens) else None

    def take(self) -> _Token:
        token = self.peek()
        if token is None:
            raise _NotADate
        self.at += 1
        return token

    def mean(self, token: _Token) -> tuple[str, int] | None:
        """What a word names: a month, a weekday or a meridian, then the
        zone's own abbreviations, then every other word.

        One of the zone's names, dots dropped, is a ``named`` zone, 1 for
        daylight time and -1 for a name both seasons use; GMT, UT and UTC
        keep their fixed meaning even where the zone uses them.

        Args:
            token (_Token): a word.
        """
        found = _meaning(token.text)
        if found is not None and found[0] in ("meridian", "month", "weekday"):
            return found
        bare = token.text.replace(".", "")
        if bare in self.names and bare not in _FIXED_NAMES:
            dst = self.names[bare]
            return "named", -1 if dst is None else int(dst)
        return found

    def kind(self, ahead: int = 0) -> str | None:
        """The kind of the token ``ahead``: a word's meaning, else its own."""
        token = self.peek(ahead)
        if token is None:
            return None
        if token.kind == "word":
            meaning = self.mean(token)
            return None if meaning is None else meaning[0]
        return token.kind

    def value(self, token: _Token) -> int:
        """The value of a word whose kind was looked at."""
        meaning = self.mean(token)
        if meaning is None:
            raise _NotADate
        return meaning[1]

    def char(self, char: str, ahead: int = 0) -> bool:
        token = self.peek(ahead)
        return (
            token is not None and token.kind == "char" and token.text == char
        )

    def plain(self, ahead: int = 0) -> bool:
        """Whether the token ``ahead`` is a whole number with no sign."""
        token = self.peek(ahead)
        return (
            token is not None
            and token.kind == "number"
            and not token.sign
            and token.nanos is None
        )

    def minus(self, ahead: int = 0) -> bool:
        """Whether the token ``ahead`` is a whole number ``-`` signs."""
        token = self.peek(ahead)
        return (
            token is not None
            and token.kind == "number"
            and token.sign == "-"
            and token.nanos is None
        )

    def signed(self, ahead: int = 0) -> bool:
        """Whether the token ``ahead`` is a signed whole number: a signed
        fraction is never a zone correction, only seconds."""
        token = self.peek(ahead)
        return (
            token is not None
            and token.kind == "number"
            and bool(token.sign)
            and token.nanos is None
        )

    def unit(self, ahead: int = 0) -> bool:
        return self.kind(ahead) in _UNIT_KINDS

    def whole(self) -> _Token:
        """Take a whole number with no sign."""
        if not self.plain():
            raise _NotADate
        return self.take()

    def parse(self) -> _Reading:
        if self.char("@"):
            self.take()
            stamp = self.take()
            if stamp.kind != "number" or self.peek() is not None:
                raise _NotADate
            nanos = abs(stamp.value) * _NANOS + (stamp.nanos or 0)
            self.reading.epoch = divmod(
                -nanos if stamp.sign == "-" else nanos, _NANOS
            )
            return self.reading
        while self.peek() is not None:
            self.item()
        return self.reading

    def item(self) -> None:
        token = self.take()
        if token.kind == "number":
            self.number(token)
            return
        meaning = self.mean(token) if token.kind == "word" else None
        if meaning is None:
            raise _NotADate
        kind, value = meaning
        if kind == "month":
            self.month(value)
        elif kind == "weekday":
            self.set_weekday(0, value)
            # Only a bare weekday takes a comma after it.
            if self.char(","):
                self.take()
        elif kind == "ordinal":
            if self.kind() == "weekday":
                self.set_weekday(value, self.value(self.take()))
            elif self.unit():
                self.relative(value)
            else:
                raise _NotADate
        elif kind in _UNIT_KINDS:
            self.add(kind, value, 1)
        elif kind == "today":
            self.tally("days", 1, value)
        elif (
            kind == "zone"
            and token.text == "T"
            and self.iso_end == self.at - 1
        ):
            # A time of day: `H:M[:S]`, or an hour that a zone correction
            # must follow.
            if self.plain() and self.char(":", 1):
                self.clock(self.take(), meridian=False)
            elif self.plain() and self.signed(1):
                self.set_clock(self.take().value, 0, 0, 0)
                self.set_zone(self.zone_number(self.take()))
            else:
                raise _NotADate
        elif kind == "zone":
            offset = value * 60
            if self.kind() == "dst":
                self.take()
                offset += 3600
            elif self.signed_zone():
                offset += self.zone_number(self.take())
            elif self.signed() and self.unit(1):
                # `UTC +1 day` is the zone and a relative item, which then
                # takes no `ago`.
                self.set_zone(offset)
                count = self.take().value
                kind, size = _unit(self.take())
                self.add(kind, size, count, suffix=False)
                return
            self.set_zone(offset)
        elif kind == "daylight":
            self.set_zone(value * 60)
        elif kind == "local":
            self.set_zone(None)
        elif kind == "named":
            if self.kind() == "dst":
                self.take()
                value = 1
            self.set_zone(None)
            self.reading.named = True
            self.reading.dst = None if value < 0 else bool(value)
        else:
            raise _NotADate

    def number(self, token: _Token) -> None:
        if token.nanos is not None:
            self.fraction(token)
        elif token.sign:
            if not self.unit():
                raise _NotADate
            self.relative(token.value)
        elif self.char(":"):
            self.clock(token, meridian=True)
        elif self.char("/"):
            self.slashed(token)
        elif self.minus() and self.minus(1):
            self.iso(token)
        elif self.kind() == "month":
            self.day_month(token)
        elif self.unit():
            self.relative(token.value)
        elif self.kind() == "weekday":
            self.set_weekday(token.value, self.value(self.take()))
        elif self.kind() == "meridian":
            hour = self.meridian(token.value, self.value(self.take()))
            self.set_clock(hour, 0, 0, 0)
        else:
            self.pure(token)

    def pure(self, token: _Token) -> None:
        """A number standing alone: a year, a date, or a time of day.

        One a zone correction follows is an hour, whatever its digits, and
        no signed number may follow a ``±HHMM`` correction there (one may
        follow ``±H:M``). Otherwise, after a date with no year and before
        any relative item, it is the year, when a time of day came first or
        it has three digits or more; five digits or more are ``[YY]YYMMDD``
        and fewer are ``HH`` or ``HHMM``.
        """
        reading, digits, value = self.reading, len(token.text), token.value
        date = reading.date
        if self.signed_zone():
            colon = self.char(":", 1) and self.plain(2)
            self.set_clock(value, 0, 0, 0)
            self.set_zone(self.zone_number(self.take()))
            if not colon and self.signed():
                raise _NotADate
        elif (
            date is not None
            and date[0] is None
            and not reading.relative
            and (reading.clock is not None or digits > 2)
        ):
            reading.date = (_year_of(token), date[1], date[2])
        elif digits > 4:
            year = value // 10000
            if digits == 6:
                year += 2000 if year < 69 else 1900
            self.set_date(year, value // 100 % 100, value % 100)
        elif digits <= 2:
            self.set_clock(value, 0, 0, 0)
        else:
            self.set_clock(value // 100, value % 100, 0, 0)

    def clock(self, hour: _Token, meridian: bool) -> None:
        """``H:M[:S[.frac]]``, then a meridian or a zone correction."""
        self.take()
        minute = self.whole().value
        second = nanos = 0
        if self.char(":"):
            self.take()
            token = self.take()
            if token.kind != "number" or token.sign:
                raise _NotADate
            second, nanos = token.value, token.nanos or 0
        value = hour.value
        if meridian and self.kind() == "meridian":
            value = self.meridian(value, self.value(self.take()))
            self.set_clock(value, minute, second, nanos)
            return
        self.set_clock(value, minute, second, nanos)
        if self.signed():
            self.set_zone(self.zone_number(self.take()))

    def slashed(self, first: _Token) -> None:
        """``M/D``, ``M/D/Y`` or, four digits leading, ``Y/M/D``."""
        self.take()
        second = self.whole()
        third = None
        if self.char("/"):
            self.take()
            third = self.whole()
        if len(first.text) >= 4:
            if third is None:
                raise _NotADate
            self.set_date(first.value, second.value, third.value)
        else:
            self.set_date(
                None if third is None else _year_of(third),
                first.value,
                second.value,
            )

    def iso(self, year: _Token) -> None:
        """``Y-M-D``, read as the year and two ``-`` signed numbers."""
        month, day = self.take(), self.take()
        self.set_date(_year_of(year), -month.value, -day.value)
        self.iso_end = self.at

    def day_month(self, day: _Token) -> None:
        """``D [-]MONTH [Y]``: a number after the month is its year."""
        month = self.value(self.take())
        year = None
        if self.plain() or self.minus():
            year = _year_of(self.take())
        self.set_date(year, month, day.value)

    def month(self, month: int) -> None:
        """``MONTH D[, Y]`` or ``MONTH -D -Y``."""
        if self.plain():
            day = self.take().value
            year = None
            if self.char(","):
                self.take()
                year = _year_of(self.whole())
            self.set_date(year, month, day)
        elif self.minus() and self.minus(1):
            dash_day, dash_year = self.take(), self.take()
            self.set_date(_year_of(dash_year), month, -dash_day.value)
        else:
            raise _NotADate

    def fraction(self, token: _Token) -> None:
        """``N.F SECONDS [ago|hence]``: only seconds take a fraction."""
        if self.kind() != "seconds" or self.value(self.take()) != 1:
            raise _NotADate
        times = -1 if token.sign == "-" else 1
        if self.kind() == "suffix":
            times *= self.value(self.take())
        self.tally("seconds", 1, times * abs(token.value))
        self.reading.nanos += times * (token.nanos or 0)

    def relative(self, count: int) -> None:
        """``count UNIT [ago|hence]``, the unit next."""
        kind, size = _unit(self.take())
        self.add(kind, size, count)

    def add(
        self, kind: str, size: int, count: int, suffix: bool = True
    ) -> None:
        if suffix and self.kind() == "suffix":
            count *= self.value(self.take())
        self.tally(kind, size, count)

    def tally(self, kind: str, size: int, count: int) -> None:
        """Add ``count`` units of ``size`` to the relative ``kind``, each
        unit counted on its own, a week's and a fortnight's as days."""
        if kind == "days":
            count, size = count * size, 1
        reading = self.reading
        total = reading.counts.get((kind, size), 0) + count
        if not (-_INT64 <= count < _INT64 and -_INT64 <= total < _INT64):
            raise _NotADate
        reading.counts[kind, size] = total
        setattr(reading, kind, getattr(reading, kind) + size * count)
        reading.relative = True

    def signed_zone(self) -> bool:
        """Whether a signed number comes next that is no relative item's."""
        return self.signed() and not self.unit(1)

    def zone_number(self, token: _Token) -> int:
        """A zone correction in seconds east.

        ``±H`` and ``±HH`` are hours, a longer number hours and minutes as
        ``±HHMM`` reads, its leading zeros aside, and ``±H:M`` takes any
        count of minutes.
        """
        if token.nanos is not None:
            raise _NotADate
        size = abs(token.value)
        if self.char(":") and self.plain(1):
            self.take()
            minutes = size * 60 + self.take().value
        elif len(token.text) <= 2:
            minutes = size * 60
        else:
            minutes = size // 100 * 60 + size % 100
        if minutes > _ZONE_LIMIT:
            raise _NotADate
        return (-minutes if token.sign == "-" else minutes) * 60

    def meridian(self, hour: int, add: int) -> int:
        if not 1 <= hour <= 12:
            raise _NotADate
        return hour % 12 + add

    def set_date(self, year: int | None, month: int, day: int) -> None:
        if self.reading.date is not None:
            raise _NotADate
        self.reading.date = (year, month, day)

    def set_clock(
        self, hour: int, minute: int, second: int, nanos: int
    ) -> None:
        if self.reading.clock is not None:
            raise _NotADate
        self.reading.clock = (hour, minute, second, nanos)

    def set_zone(self, offset: int | None) -> None:
        if self.reading.zoned:
            raise _NotADate
        self.reading.zoned = True
        self.reading.zone = offset

    def set_weekday(self, ordinal: int, day: int) -> None:
        if self.reading.weekday is not None:
            raise _NotADate
        self.reading.weekday = (ordinal, day)


def _civil_days(year: int, month: int, day: int) -> int:
    """Days from 1970-01-01 to a proleptic Gregorian date.

    A month past 12 or below 1 carries into the year, and a day past the
    month's end into the months after, as a calendar shift needs.

    Args:
        year (int): the year.
        month (int): the month, 1 for January.
        day (int): the day of the month.
    """
    year += (month - 1) // 12
    month = (month - 1) % 12 + 1
    # Counted from March, so February's leap day ends the year.
    shifted = year - (month <= 2)
    march = month + 9 if month <= 2 else month - 3
    days = 365 * shifted + shifted // 4 - shifted // 100 + shifted // 400
    return days + (153 * march + 2) // 5 + day - 1 - 719468


def _wall_fields(wall: int) -> tuple[int, int, int, int, int, int]:
    """The calendar fields of wall-clock seconds read as UTC.

    Args:
        wall (int): seconds since 1970-01-01 00:00:00 on that clock.
    """
    shown = datetime(1970, 1, 1) + timedelta(seconds=wall)
    return (
        shown.year,
        shown.month,
        shown.day,
        shown.hour,
        shown.minute,
        shown.second,
    )


class _Clock:
    """The UTC offsets a zone shows, ``tz`` or the host's own for None."""

    def __init__(self, tz: tzinfo | None) -> None:
        self.tz = tz

    def offset(self, instant: int) -> int:
        """Seconds east of UTC at an instant.

        Args:
            instant (int): epoch seconds; one outside what mirage holds
                reads as the nearest it does, a few days in.
        """
        instant = min(
            max(instant, _FIRST_SECOND + 2 * _DAY), _LAST_SECOND - 2 * _DAY
        )
        if self.tz is None:
            return time.localtime(instant).tm_gmtoff
        shift = datetime.fromtimestamp(instant, self.tz).utcoffset()
        return 0 if shift is None else int(shift.total_seconds())

    def abbreviation(self, instant: int) -> str:
        """The zone's abbreviation at an instant, upper-cased.

        Args:
            instant (int): epoch seconds.
        """
        if self.tz is None:
            return time.localtime(instant).tm_zone.upper()
        return (
            datetime.fromtimestamp(instant, self.tz).tzname() or ""
        ).upper()

    def isdst(self, instant: int) -> bool:
        """Whether an instant is in daylight time: ahead of the lesser of
        the offsets its year shows on January 1 and July 1, or behind the
        offsets of both the January 1 or July 1 before it and the one
        after, as Ramadan's hour back in Casablanca is.

        Args:
            instant (int): epoch seconds.
        """
        year = _wall_fields(min(max(instant, _FIRST_SECOND), _LAST_SECOND))[0]
        winter = self.offset(_civil_days(year, 1, 1) * _DAY)
        july = _civil_days(year, 7, 1) * _DAY
        summer = self.offset(july)
        shown = self.offset(instant)
        if shown > min(winter, summer):
            return True
        if instant < july:
            before, after = winter, summer
        else:
            before, after = (
                summer,
                self.offset(_civil_days(year + 1, 1, 1) * _DAY),
            )
        return shown < before and shown < after

    def names(self, now: int) -> dict[str, bool | None]:
        """The abbreviations the zone shows now and 90, 180 and 270 days
        on, the instants date reads its names at, each with whether it
        names daylight time, None for one both seasons use.

        Args:
            now (int): the current epoch second.
        """
        found: dict[str, bool | None] = {}
        for step in range(4):
            instant = min(now + step * 90 * _DAY, _LAST_SECOND)
            name = self.abbreviation(instant)
            dst = self.isdst(instant)
            found[name] = dst if found.get(name, dst) == dst else None
        return found

    def rule_changes(self, wall: int) -> tuple[int, ...]:
        """When a POSIX rule changes the clock in ``wall``'s year; none for
        a zone from tzdata.

        Args:
            wall (int): wall-clock seconds, the fields read as UTC.
        """
        if self.tz is None:
            return ()
        year = _wall_fields(min(max(wall, _FIRST_SECOND), _LAST_SECOND))[0]
        return posix_transitions(self.tz, year) or ()

    def readings(self, wall: int) -> list[int]:
        """The instants this zone's clock reads ``wall`` at: one, two in an
        hour repeated when DST ends, none in one skipped when it starts.

        Args:
            wall (int): wall-clock seconds, the fields read as UTC.
        """
        offsets = {self.offset(wall - _DAY), self.offset(wall + _DAY)}
        # A POSIX rule's daylight time can be shorter than a day.
        offsets.update(
            self.offset(change) for change in self.rule_changes(wall)
        )
        return sorted(
            wall - offset
            for offset in offsets
            if self.offset(wall - offset) == offset
        )

    def place(self, wall: int, guess: int) -> int:
        """The instant this zone's clock reads ``wall`` at.

        The search starts under ``guess``, so a reading the clock shows
        twice takes the side of the change whose offset ``guess`` is. One
        it never shows is read under the offset before the change.

        Args:
            wall (int): wall-clock seconds, the fields read as UTC.
            guess (int): the offset to start from, seconds east.
        """
        instant = wall - guess
        for _ in range(2):
            shown = self.offset(instant)
            if self.offset(wall - shown) == shown:
                return wall - shown
            instant = wall - shown
        return wall - self.offset(wall - _DAY)

    def settle(self, wall: int, guess: int, dst: bool | None) -> int | None:
        """The instant a wall clock the expression names reads at, None
        when the clock never reads it (or not in the daylight state ``dst``
        asks for).

        Args:
            wall (int): wall-clock seconds, the fields read as UTC.
            guess (int): the offset that picks between two readings.
            dst (bool | None): the daylight state required, None for any.
        """
        shown = [
            instant
            for instant in self.readings(wall)
            if dst is None or self.isdst(instant) == dst
        ]
        if len(shown) == 2:
            placed = self.place(wall, guess)
            return placed if placed in shown else shown[-1]
        return shown[0] if shown else None

    def keep_state(self, wall: int, dst: bool, guess: int) -> int:
        """The instant a moved wall clock reads at, kept in daylight state
        ``dst``: a reading in another state, or none, is read under the
        offset of the nearest time in that state.

        Args:
            wall (int): wall-clock seconds, the fields read as UTC.
            dst (bool): the daylight state to keep.
            guess (int): the offset that picks between two readings.
        """
        shown = [
            instant
            for instant in self.readings(wall)
            if self.isdst(instant) == dst
        ]
        if shown:
            return self.place(wall, guess) if len(shown) == 2 else shown[0]
        # A POSIX rule's daylight time can be shorter than any step.
        for change in self.rule_changes(wall):
            if self.isdst(change) == dst:
                return wall - self.offset(change)
        for step in range(1, 14):
            for instant in (wall - step * 30 * _DAY, wall + step * 30 * _DAY):
                if self.isdst(instant) == dst:
                    return wall - self.offset(instant)
        return self.place(wall, guess)


def _weekday_shift(base: int, ordinal: int, day: int) -> int:
    """Days from a weekday to the ``ordinal``-th ``day`` from it.

    Ordinal 0 is that day this week, today included; a positive one counts
    occurrences after today; -1 is the last one before it.

    Args:
        base (int): the starting weekday, 0 for Sunday.
        ordinal (int): which occurrence.
        day (int): the weekday sought, 0 for Sunday.
    """
    ahead = (day - base) % 7
    if ordinal > 0:
        return (ahead or 7) + 7 * (ordinal - 1)
    if ordinal == 0:
        return ahead
    return -((base - day) % 7 or 7) + 7 * (ordinal + 1)


def _resolve(
    reading: _Reading, clock: _Clock, now: int, now_nanos: int, guess: int
) -> tuple[int, int] | None:
    """Place a reading in time, as ``(epoch seconds, nanoseconds)``.

    A field left out comes from now on the zone's clock, and the time of
    day is midnight unless only relative items (and a zone) were given.
    The wall clock named must exist on the zone's clock, a skipped hour
    refused and a repeated one read on now's side, unless a zone given
    reads it. A weekday moves the date, then days, months
    and years move it on the calendar, read from the side of any change
    the base was on; the zone and the hours, minutes and seconds then
    move the instant. A shift keeps the daylight state a name of the zone
    gives, and a shift of now's own clock now's, as date's does.

    Args:
        reading (_Reading): the parsed expression.
        clock (_Clock): the zone it is read in.
        now (int): the current epoch second.
        now_nanos (int): its nanoseconds.
        guess (int): the offset a repeated wall clock is first read under:
            now's, in the zone the command runs in even when ``TZ="..."``
            names another.
    """
    if reading.epoch is not None:
        return reading.epoch
    here = clock.offset(now)
    year, month, day, hour, minute, second = _wall_fields(now + here)
    nanos = now_nanos
    from_now = (
        reading.relative
        and reading.date is None
        and reading.clock is None
        and reading.weekday is None
    )
    if reading.date is not None:
        given, month, day = reading.date
        year = year if given is None else given
    if reading.clock is not None:
        hour, minute, second, nanos = reading.clock
    elif not from_now:
        hour = minute = second = nanos = 0
    if not 1 <= month <= 12:
        return None
    month_days = _civil_days(year, month + 1, 1) - _civil_days(year, month, 1)
    if not 1 <= day <= month_days:
        return None
    if hour > 23 or minute > 59 or second > 59:
        return None
    days = _civil_days(year, month, day)
    within = hour * 3600 + minute * 60 + second
    state = clock.isdst(now) if reading.dst is None else reading.dst
    if reading.zone is not None:
        # A zone given reads the wall clock as its own, whether or not the
        # zone's clock shows it.
        instant = days * _DAY + within - reading.zone
    elif from_now and reading.dst is None:
        instant = now
    else:
        # A shift of now's wall clock starts in the daylight state the zone
        # name asks for.
        settled = clock.settle(days * _DAY + within, guess, reading.dst)
        if settled is None:
            return None
        instant = settled
    moving = bool(reading.days or reading.months)
    if reading.weekday is not None and reading.date is None:
        days += _weekday_shift((days + 4) % 7, *reading.weekday)
        year, month, day = _wall_fields(days * _DAY)[:3]
        moving = True
    if moving:
        wall = (
            _civil_days(year, month + reading.months, day) + reading.days
        ) * _DAY + within
        # A name both seasons use places the shift where it lands.
        if reading.dst is not None or (from_now and not reading.named):
            instant = clock.keep_state(wall, state, guess)
        else:
            instant = clock.place(wall, clock.offset(instant))
        if reading.zone is not None:
            instant += clock.offset(instant) - reading.zone
    carry, nanos = divmod(nanos + reading.nanos, _NANOS)
    return instant + reading.seconds + carry, nanos


def _split_zone(text: str) -> tuple[str | None, str]:
    """A leading ``TZ="..."`` and the rest, or no zone and the text.

    Inside the quotes a backslash escapes a backslash or a quote, and
    nothing else.

    Args:
        text (str): the expression.
    """
    lead = text.lstrip(_BLANKS)
    if not lead.startswith('TZ="'):
        return None, text
    value: list[str] = []
    at = 4
    while at < len(lead):
        char = lead[at]
        if char == '"':
            return "".join(value), lead[at + 1 :]
        if char == "\\":
            escaped = lead[at + 1 : at + 2]
            if escaped not in ("\\", '"'):
                raise _NotADate
            char = escaped
            at += 1
        value.append(char)
        at += 1
    raise _NotADate


def parse_date_expr(
    text: str, tz: tzinfo | None = None, now: datetime | None = None
) -> datetime | None:
    """Parse a free-form date expression as ``date -d`` reads it.

    The grammar is coreutils 9.7's as measured on debian:stable-slim:
    calendar dates (``2026-01-15``, ``1/15/26``, ``15 Jan 2026``,
    ``Jan 15, 2026``, ``20260115``), times of day (``10:30:45.5``,
    ``9pm``) with zone corrections (``+05:30``), zone names (``UTC``,
    ``EST DST``, ``UTC+3``, military letters), days of the week
    (``next monday``), relative items (``2 days ago``, ``tomorrow``),
    ``@epoch`` and a leading ``TZ="zone"``, with parenthesized comments
    ignored. None is date's ``invalid date``; mirage also refuses a
    moment outside years 1-9999, which date shows.

    Args:
        text (str): the expression.
        tz (tzinfo | None): the zone it is read and returned in, None for
            the host's local zone (and a naive result).
        now (datetime | None): the current moment, injectable for tests;
            a naive one is the host's local time.
    """
    try:
        inner, rest = _split_zone(text)
        if now is None:
            current, current_nanos = divmod(time.time_ns(), _NANOS)
        else:
            current = round(now.replace(microsecond=0).timestamp())
            current_nanos = now.microsecond * 1000
        outer = _Clock(tz)
        clock = outer if inner is None else _Clock(resolve_tz(inner))
        reading = _Parser(_lex(rest), clock.names(current)).parse()
        placed = _resolve(
            reading, clock, current, current_nanos, outer.offset(current)
        )
        if placed is None:
            return None
        instant, nanos = placed
        if not _FIRST_SECOND <= instant <= _LAST_SECOND:
            return None
        micros = nanos // 1000
        if tz is None:
            return datetime.fromtimestamp(instant).replace(microsecond=micros)
        moment = datetime.fromtimestamp(instant, timezone.utc).replace(
            microsecond=micros
        )
        return moment.astimezone(tz)
    except (_NotADate, OverflowError, ValueError, OSError):
        return None


def _localize(wall: datetime, tz: tzinfo | None) -> datetime | None:
    """The moment ``tz``'s clock reads a naive wall time, None if it never does.

    A reading the clock shows twice is the later. The host's zone is not
    checked: the wall time comes back naive, read as local when used.

    Args:
        wall (datetime): the naive wall-clock time.
        tz (tzinfo | None): the zone, None for the host's local zone.
    """
    if tz is None:
        return wall
    seconds = _civil_days(wall.year, wall.month, wall.day) * _DAY
    seconds += wall.hour * 3600 + wall.minute * 60 + wall.second
    shown = _Clock(tz).readings(seconds)
    if not shown:
        return None
    return datetime.fromtimestamp(shown[-1], tz)


def parse_posix_time(
    text: str, *, tz: tzinfo | None = None, now: datetime | None = None
) -> datetime | None:
    """Parse the ``MMDDhhmm[[CC]YY][.ss]`` a bare ``date`` operand is.

    As GNU date reads it, measured on coreutils 9.7: no year is this year, a
    two-digit one is 2000-2068 up to 68 and 1969-1999 from 69, and ``.ss``
    takes exactly two digits. A field out of range (``1301000024``,
    ``01012500``) is not a date, nor is a wall clock ``tz`` skips; second 60 is
    the next minute's first, as mktime reads a leap second. One divergence: GNU
    shows year 0 and year 10000, where mirage holds what ``datetime`` holds, so
    a year 0 operand, a UTC moment outside years 1-9999 and the leap second
    after 9999-12-31 23:59:59 are not a date either.

    Args:
        text (str): the operand as typed.
        tz (tzinfo | None): the zone the wall clock is read in, None for
            the host's local zone.
        now (datetime | None): the current moment, injectable for tests.
    """
    match = _POSIX_TIME_RE.fullmatch(text)
    if match is None:
        return None
    digits, dot = match.group(1), match.group(2)
    month, day, hour, minute = (int(digits[i : i + 2]) for i in range(0, 8, 2))
    tail = digits[8:]
    if not tail:
        year = (now if now is not None else datetime.now(tz)).year
    elif len(tail) == 2:
        year = int(tail) + (2000 if int(tail) <= 68 else 1900)
    else:
        year = int(tail)
    second = int(dot[1:]) if dot else 0
    leap = second == 60
    try:
        wall = datetime(year, month, day, hour, minute, 59 if leap else second)
    except ValueError:
        return None
    try:
        placed = _localize(wall, tz)
        if placed is None:
            return None
        first = placed.timestamp()
        if first < _FIRST_SECOND or first + leap > _LAST_SECOND:
            return None
        # Adding to an aware moment resets ``fold``, so only a leap second
        # does: the later of two readings stays the later.
        return placed + timedelta(seconds=1) if leap else placed
    except (OverflowError, ValueError):
        return None


def utc_date_folder(ts: float) -> str:
    """The UTC day ``ts`` falls on, as ``YYYY-MM-DD``.

    Args:
        ts (float): seconds since the unix epoch.
    """
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d")


def iso_timestamp(value: str | None) -> float | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def timestamp_iso(epoch: float | None) -> str | None:
    """Spell an epoch seconds value the way the setattr op reads times.

    The inverse of ``iso_timestamp``. A guest hands `os.utime` epoch
    floats and the op takes ISO text, so the conversion lives here
    rather than in each runtime surface.

    Args:
        epoch (float | None): seconds since the epoch, or None.

    Returns:
        str | None: UTC ISO text, or None when there is no time.
    """
    if epoch is None:
        return None
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat()


def in_mtime_window(
    timestamp: float | None, mtime_min: float | None, mtime_max: float | None
) -> bool:
    if mtime_min is None and mtime_max is None:
        return True
    if timestamp is None:
        return False
    if mtime_min is not None and timestamp < mtime_min:
        return False
    if mtime_max is not None and timestamp > mtime_max:
        return False
    return True


def to_iso_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def now_iso() -> str:
    return to_iso_z(datetime.now(timezone.utc))


def ns_to_iso(ns: int) -> str:
    """Spell a host file time in UTC to the millisecond, as Node's stat does.

    Node renders a stat time as ``Date(Math.round(sec * 1e3 + nsec / 1e6))``;
    rounding the same double here keeps a disk mount's times byte-identical
    across hosts, and the fraction is what ``find -newer`` compares.

    Args:
        ns (int): unix epoch nanoseconds (``st_mtime_ns``).
    """
    sec, nsec = divmod(ns, 1_000_000_000)
    whole, ms = divmod(math.floor(sec * 1e3 + nsec / 1e6 + 0.5), 1000)
    stamp = datetime.fromtimestamp(whole, tz=timezone.utc)
    return f"{stamp:%Y-%m-%dT%H:%M:%S}.{ms:03d}Z"


def epoch_to_iso(seconds: float) -> str:
    """Convert unix epoch seconds to a second-precision UTC ISO-8601 string.

    Floored to whole seconds (matching the TypeScript ``Math.floor``) so
    the two converters produce byte-identical output for negative
    (pre-1970) fractional timestamps as well.

    Args:
        seconds (float): unix epoch seconds (sub-second part is dropped).
    """
    return to_iso_z(
        datetime.fromtimestamp(math.floor(seconds), tz=timezone.utc)
    )


def iso_to_epoch(iso: str) -> int:
    """Convert an ISO-8601 string to whole unix epoch seconds.

    The inverse of epoch_to_iso; a naive stamp (no offset, e.g. a
    ``touch -t`` overlay time) is read as UTC so Python and TypeScript
    agree. Floored to whole seconds (matching the TypeScript
    ``Math.floor``) so a negative fractional epoch yields the same value
    in both languages.

    Args:
        iso (str): ISO-8601 timestamp, with or without a ``Z``/offset.
    """
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return math.floor(dt.timestamp())
