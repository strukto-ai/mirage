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
from calendar import monthrange
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone, tzinfo

from mirage.utils.timezone import resolve_tz

_EPOCH_RE = re.compile(r"@\s*[+-]?\d+(?:\.\d+)?")
# POSIX `MMDDhhmm[[CC]YY][.ss]`, the clock a bare `date` operand sets.
# [0-9], not \d: python's \d also matches Unicode digits, which gnulib
# refuses.
_POSIX_TIME_RE = re.compile(r"([0-9]{8}|[0-9]{10}|[0-9]{12})(\.[0-9]{2})?")
_FIRST_SECOND = datetime.min.replace(tzinfo=timezone.utc).timestamp()
_LAST_SECOND = datetime.max.replace(
    tzinfo=timezone.utc, microsecond=0
).timestamp()


_SPACES = " \t\n\v\f\r"
_HOUR = 3600
_BILLION = 1_000_000_000
_MER24, _AM, _PM = 0, 1, 2
# Each unit token's field of a relative item.
_UNITS = {
    "YEAR_UNIT": "year",
    "MONTH_UNIT": "month",
    "DAY_UNIT": "day",
    "HOUR_UNIT": "hour",
    "MINUTE_UNIT": "minutes",
    "SEC_UNIT": "seconds",
}

# gnulib parse-datetime's word tables (coreutils 9.7), in the order
# lookup_word tries them.
_MERIDIANS = {"AM": _AM, "A.M.": _AM, "PM": _PM, "P.M.": _PM}
_MONTHS_AND_DAYS = (
    ("JANUARY", "MONTH", 1),
    ("FEBRUARY", "MONTH", 2),
    ("MARCH", "MONTH", 3),
    ("APRIL", "MONTH", 4),
    ("MAY", "MONTH", 5),
    ("JUNE", "MONTH", 6),
    ("JULY", "MONTH", 7),
    ("AUGUST", "MONTH", 8),
    ("SEPTEMBER", "MONTH", 9),
    ("SEPT", "MONTH", 9),
    ("OCTOBER", "MONTH", 10),
    ("NOVEMBER", "MONTH", 11),
    ("DECEMBER", "MONTH", 12),
    ("SUNDAY", "DAY", 0),
    ("MONDAY", "DAY", 1),
    ("TUESDAY", "DAY", 2),
    ("TUES", "DAY", 2),
    ("WEDNESDAY", "DAY", 3),
    ("WEDNES", "DAY", 3),
    ("THURSDAY", "DAY", 4),
    ("THUR", "DAY", 4),
    ("THURS", "DAY", 4),
    ("FRIDAY", "DAY", 5),
    ("SATURDAY", "DAY", 6),
)
_TIME_UNITS = {
    "YEAR": ("YEAR_UNIT", 1),
    "MONTH": ("MONTH_UNIT", 1),
    "FORTNIGHT": ("DAY_UNIT", 14),
    "WEEK": ("DAY_UNIT", 7),
    "DAY": ("DAY_UNIT", 1),
    "HOUR": ("HOUR_UNIT", 1),
    "MINUTE": ("MINUTE_UNIT", 1),
    "MIN": ("MINUTE_UNIT", 1),
    "SECOND": ("SEC_UNIT", 1),
    "SEC": ("SEC_UNIT", 1),
}
_RELATIVE_WORDS = {
    "TOMORROW": ("DAY_SHIFT", 1),
    "YESTERDAY": ("DAY_SHIFT", -1),
    "TODAY": ("DAY_SHIFT", 0),
    "NOW": ("DAY_SHIFT", 0),
    "LAST": ("ORDINAL", -1),
    "THIS": ("ORDINAL", 0),
    "NEXT": ("ORDINAL", 1),
    "FIRST": ("ORDINAL", 1),
    "THIRD": ("ORDINAL", 3),
    "FOURTH": ("ORDINAL", 4),
    "FIFTH": ("ORDINAL", 5),
    "SIXTH": ("ORDINAL", 6),
    "SEVENTH": ("ORDINAL", 7),
    "EIGHTH": ("ORDINAL", 8),
    "NINTH": ("ORDINAL", 9),
    "TENTH": ("ORDINAL", 10),
    "ELEVENTH": ("ORDINAL", 11),
    "TWELFTH": ("ORDINAL", 12),
    "AGO": ("AGO", -1),
    "HENCE": ("AGO", 1),
}
_UNIVERSAL_ZONES = {"GMT": 0, "UT": 0, "UTC": 0}
# Seconds east of UTC; a DAYZONE is an hour more.
_ZONES = {
    "WET": ("ZONE", 0),
    "WEST": ("DAYZONE", 0),
    "BST": ("DAYZONE", 0),
    "ART": ("ZONE", -3 * _HOUR),
    "BRT": ("ZONE", -3 * _HOUR),
    "BRST": ("DAYZONE", -3 * _HOUR),
    "NST": ("ZONE", -(3 * _HOUR + 1800)),
    "NDT": ("DAYZONE", -(3 * _HOUR + 1800)),
    "AST": ("ZONE", -4 * _HOUR),
    "ADT": ("DAYZONE", -4 * _HOUR),
    "CLT": ("ZONE", -4 * _HOUR),
    "CLST": ("DAYZONE", -4 * _HOUR),
    "EST": ("ZONE", -5 * _HOUR),
    "EDT": ("DAYZONE", -5 * _HOUR),
    "CST": ("ZONE", -6 * _HOUR),
    "CDT": ("DAYZONE", -6 * _HOUR),
    "MST": ("ZONE", -7 * _HOUR),
    "MDT": ("DAYZONE", -7 * _HOUR),
    "PST": ("ZONE", -8 * _HOUR),
    "PDT": ("DAYZONE", -8 * _HOUR),
    "AKST": ("ZONE", -9 * _HOUR),
    "AKDT": ("DAYZONE", -9 * _HOUR),
    "HST": ("ZONE", -10 * _HOUR),
    "HAST": ("ZONE", -10 * _HOUR),
    "HADT": ("DAYZONE", -10 * _HOUR),
    "SST": ("ZONE", -12 * _HOUR),
    "WAT": ("ZONE", _HOUR),
    "CET": ("ZONE", _HOUR),
    "CEST": ("DAYZONE", _HOUR),
    "MET": ("ZONE", _HOUR),
    "MEZ": ("ZONE", _HOUR),
    "MEST": ("DAYZONE", _HOUR),
    "MESZ": ("DAYZONE", _HOUR),
    "EET": ("ZONE", 2 * _HOUR),
    "EEST": ("DAYZONE", 2 * _HOUR),
    "CAT": ("ZONE", 2 * _HOUR),
    "SAST": ("ZONE", 2 * _HOUR),
    "EAT": ("ZONE", 3 * _HOUR),
    "MSK": ("ZONE", 3 * _HOUR),
    "MSD": ("DAYZONE", 3 * _HOUR),
    "IST": ("ZONE", 5 * _HOUR + 1800),
    "SGT": ("ZONE", 8 * _HOUR),
    "KST": ("ZONE", 9 * _HOUR),
    "JST": ("ZONE", 9 * _HOUR),
    "GST": ("ZONE", 10 * _HOUR),
    "NZST": ("ZONE", 12 * _HOUR),
    "NZDT": ("DAYZONE", 12 * _HOUR),
}
# The military letters, RFC 5322's way round; T is the ISO 8601
# separator and J the local zone.
_MILITARY = {
    **{letter: (i + 1) * _HOUR for i, letter in enumerate("ABCDEFGHI")},
    **{letter: (i + 10) * _HOUR for i, letter in enumerate("KLM")},
    **{letter: -(i + 1) * _HOUR for i, letter in enumerate("NOPQRS")},
    **{letter: -(i + 8) * _HOUR for i, letter in enumerate("UVWXY")},
    "Z": 0,
}


@dataclass(frozen=True, slots=True)
class _Token:
    """One lexeme of a date expression, gnulib's yylex output.

    Args:
        kind (str): the token type: UNUMBER, SNUMBER, UDECIMAL,
            SDECIMAL, a word's table type, or a lone character.
        value (int): the number or table value.
        digits (int): how many digits a number was written with.
        ns (int): a decimal's nanoseconds, always a positive offset.
        negative (bool): a number written with a minus sign, zero too.
        offset (int | None): a local zone's offset east of UTC, None
            when its abbreviation names both of the zone's offsets.
    """

    kind: str
    value: int = 0
    digits: int = 0
    ns: int = 0
    negative: bool = False
    offset: int | None = None


@dataclass
class _Rel:
    year: int = 0
    month: int = 0
    day: int = 0
    hour: int = 0
    minutes: int = 0
    seconds: int = 0
    ns: int = 0


@dataclass
class _Parsed:
    """What the items of an expression set, gnulib's parser_control: the
    calendar fields start as the current moment's, the counters count each kind
    of item.
    """

    year: int
    year_digits: int
    month: int
    day: int
    hour: int
    minutes: int
    seconds: int
    ns: int
    meridian: int = _MER24
    rel: _Rel = field(default_factory=_Rel)
    rels_seen: bool = False
    day_ordinal: int = 0
    day_number: int = 0
    time_zone: int = 0
    local_offset: int | None = None
    dates_seen: int = 0
    days_seen: int = 0
    times_seen: int = 0
    zones_seen: int = 0
    local_zones_seen: int = 0
    dsts_seen: int = 0
    j_zones_seen: int = 0


def _local_zones(tz: tzinfo | None, now: datetime) -> dict[str, int | None]:
    """The zone abbreviations the reading zone itself uses, gnulib's
    local_time_zone_table: the current one, and the first different
    offset's in the next three quarters, each with the offset it
    names. An abbreviation naming both offsets names neither.

    Args:
        tz (tzinfo | None): the zone the expression is read in.
        now (datetime): the current moment.
    """
    if tz is None or now.tzinfo is None:
        return {}
    table: dict[str, int | None] = {}
    first = now.utcoffset()
    name = now.tzname()
    if name is None or first is None:
        return table
    table[name] = int(first.total_seconds())
    for quarter in (1, 2, 3):
        probe = datetime.fromtimestamp(
            now.timestamp() + quarter * 90 * 86400, tz
        )
        offset = probe.utcoffset()
        other = probe.tzname()
        if offset is None or other is None or offset == first:
            continue
        if other == name:
            table[name] = None
        else:
            table[other] = int(offset.total_seconds())
        break
    return table


def _zone_token(word: str, local: dict[str, int | None]) -> _Token | None:
    if word in _UNIVERSAL_ZONES:
        return _Token("ZONE", _UNIVERSAL_ZONES[word])
    if word in local:
        return _Token("LOCAL_ZONE", offset=local[word])
    if word in _ZONES:
        kind, value = _ZONES[word]
        return _Token(kind, value)
    return None


def _word_token(text: str, local: dict[str, int | None]) -> _Token | None:
    """A word as gnulib's lookup_word classifies it, None for one it
    does not know.

    Args:
        text (str): the letters and dots as typed.
        local (dict[str, int | None]): the reading zone's abbreviations.
    """
    word = text.upper()
    if word in _MERIDIANS:
        return _Token("MERIDIAN", _MERIDIANS[word])
    abbrev = len(word) == 3 or (len(word) == 4 and word[3] == ".")
    for name, kind, value in _MONTHS_AND_DAYS:
        if (name[:3] == word[:3]) if abbrev else name == word:
            return _Token(kind, value)
    zone = _zone_token(word, local)
    if zone is not None:
        return zone
    if word == "DST":
        return _Token("DST")
    for unit in (word, word[:-1] if word.endswith("S") else None):
        if unit in _TIME_UNITS:
            kind, value = _TIME_UNITS[unit]
            return _Token(kind, value)
    if word in _RELATIVE_WORDS:
        kind, value = _RELATIVE_WORDS[word]
        return _Token(kind, value)
    if len(word) == 1:
        if word in ("J", "T"):
            return _Token(word)
        if word in _MILITARY:
            return _Token("ZONE", _MILITARY[word])
    if "." in word:
        return _zone_token(word.replace(".", ""), local)
    return None


def _lex(text: str, local: dict[str, int | None]) -> list[_Token] | None:
    """gnulib's yylex over the whole expression, None at a word it does not
    know or a number past 64 bits. A sign binds to the number after it, ``.``
    or ``,`` makes a decimal of up to nine fraction digits, and a parenthesized
    comment is skipped.

    Args:
        text (str): the expression.
        local (dict[str, int | None]): the reading zone's abbreviations.
    """
    tokens: list[_Token] = []
    at, end = 0, len(text)
    while True:
        while at < end and text[at] in _SPACES:
            at += 1
        if at >= end:
            return tokens
        char = text[at]
        if char in "0123456789+-":
            sign = 0
            p = at
            if char in "+-":
                sign = -1 if char == "-" else 1
                p += 1
                while p < end and text[p] in _SPACES:
                    p += 1
                if p >= end or text[p] not in "0123456789":
                    at = p
                    continue
            first = p
            while p < end and text[p] in "0123456789":
                p += 1
            value = int(text[first:p])
            if value > 2**63 - 1:
                return None
            if p + 1 < end and text[p] in ".," and text[p + 1] in "0123456789":
                q = p + 1
                while q < end and text[q] in "0123456789":
                    q += 1
                fraction = text[p + 1 : q]
                ns = int(fraction[:9].ljust(9, "0"))
                if sign < 0 and fraction[9:].strip("0"):
                    ns += 1
                seconds = -value if sign < 0 else value
                if sign < 0 and ns:
                    seconds -= 1
                    ns = _BILLION - ns
                kind = "SDECIMAL" if sign else "UDECIMAL"
                tokens.append(_Token(kind, seconds, ns=ns))
                at = q
                continue
            kind = "SNUMBER" if sign else "UNUMBER"
            signed = -value if sign < 0 else value
            tokens.append(
                _Token(kind, signed, digits=p - first, negative=sign < 0)
            )
            at = p
            continue
        if char.isascii() and char.isalpha():
            p = at
            while p < end and (
                (text[p].isascii() and text[p].isalpha()) or text[p] == "."
            ):
                p += 1
            token = _word_token(text[at:p], local)
            if token is None:
                return None
            tokens.append(token)
            at = p
            continue
        if char == "(":
            depth = 0
            while at < end:
                if text[at] == "(":
                    depth += 1
                elif text[at] == ")":
                    depth -= 1
                at += 1
                if depth == 0:
                    break
            if depth:
                return tokens
            continue
        tokens.append(_Token(char))
        at += 1


def _kind_at(tokens: list[_Token], at: int) -> str:
    return tokens[at].kind if at < len(tokens) else ""


def _unit_rel(token: _Token, count: int) -> _Rel:
    """A relative unit times a count, gnulib's relunit.

    Args:
        token (_Token): the unit.
        count (int): how many.
    """
    return _Rel(**{_UNITS[token.kind]: count * token.value})


def _apply(parsed: _Parsed, rel: _Rel, factor: int) -> None:
    """Add a relative item into the running sum, gnulib's
    apply_relative_time.

    Args:
        parsed (_Parsed): the parse state.
        rel (_Rel): the item.
        factor (int): -1 under ``ago``, else 1.
    """
    total = parsed.rel
    total.year += factor * rel.year
    total.month += factor * rel.month
    total.day += factor * rel.day
    total.hour += factor * rel.hour
    total.minutes += factor * rel.minutes
    total.seconds += factor * rel.seconds
    total.ns += factor * rel.ns
    parsed.rels_seen = True


def _relunit(tokens: list[_Token], at: int) -> tuple[_Rel, int] | None:
    """A relative unit at ``at`` with its count, and where it ends.

    Args:
        tokens (list[_Token]): the expression's tokens.
        at (int): where the unit (or its count) starts.
    """
    head = tokens[at]
    after = _kind_at(tokens, at + 1)
    if head.kind in ("ORDINAL", "UNUMBER", "SNUMBER") and after in _UNITS:
        return _unit_rel(tokens[at + 1], head.value), at + 2
    if head.kind in ("UDECIMAL", "SDECIMAL") and after == "SEC_UNIT":
        return _Rel(seconds=head.value, ns=head.ns), at + 2
    if head.kind in _UNITS:
        return _unit_rel(head, 1), at + 1
    return None


def _rel_item(parsed: _Parsed, tokens: list[_Token], at: int) -> int | None:
    """``relunit [ago|hence]``: add one relative item.

    Args:
        parsed (_Parsed): the parse state.
        tokens (list[_Token]): the expression's tokens.
        at (int): where the item starts.
    """
    found = _relunit(tokens, at)
    if found is None:
        return None
    rel, after = found
    factor = 1
    if _kind_at(tokens, after) == "AGO":
        factor = tokens[after].value
        after += 1
    _apply(parsed, rel, factor)
    return after


def _zone_hhmm(tokens: list[_Token], at: int) -> tuple[int, int] | None:
    """The numeric zone a signed number at ``at`` starts, in seconds east,
    and where it ends: gnulib's time_zone_hhmm, one or two digits of hours
    or more of hours and minutes, a ``:MM`` adding minutes, at most 24
    hours either way.

    Args:
        tokens (list[_Token]): the expression's tokens.
        at (int): the signed number's position.
    """
    number, minutes, after = tokens[at], -1, at + 1
    if _kind_at(tokens, after) == ":":
        if _kind_at(tokens, after + 1) != "UNUMBER":
            return None
        minutes = tokens[after + 1].value
        after += 2
    value = number.value
    if number.digits <= 2 and minutes < 0:
        value *= 100
    if minutes < 0:
        size = abs(value)
        total = (size // 100 * 60 + size % 100) * (-1 if value < 0 else 1)
    else:
        total = value * 60 + (-minutes if number.negative else minutes)
    if not -24 * 60 <= total <= 24 * 60:
        return None
    return total * 60, after


def _zone_offset(parsed: _Parsed, tokens: list[_Token], at: int) -> int | None:
    """An optional numeric zone after a time of day.

    Args:
        parsed (_Parsed): the parse state.
        tokens (list[_Token]): the expression's tokens.
        at (int): where the zone would start.
    """
    if _kind_at(tokens, at) != "SNUMBER":
        return at
    found = _zone_hhmm(tokens, at)
    if found is None:
        return None
    parsed.time_zone, after = found
    parsed.zones_seen += 1
    return after


def _set_time(
    parsed: _Parsed,
    hour: int,
    minutes: int,
    seconds: int,
    ns: int,
    meridian: int,
) -> None:
    parsed.hour, parsed.minutes = hour, minutes
    parsed.seconds, parsed.ns = seconds, ns
    parsed.meridian = meridian
    parsed.times_seen += 1


def _clock(
    parsed: _Parsed, tokens: list[_Token], at: int, iso: bool
) -> int | None:
    """``H:MM[:SS[.frac]]`` with a meridian, or an ISO time with an
    optional numeric zone; after a date's ``T`` only the ISO form.

    Args:
        parsed (_Parsed): the parse state.
        tokens (list[_Token]): the expression's tokens.
        at (int): the hour's position, its colon after it.
        iso (bool): only the ISO 8601 form may follow.
    """
    if _kind_at(tokens, at + 2) != "UNUMBER":
        return None
    hour, minutes = tokens[at].value, tokens[at + 2].value
    seconds, ns = 0, 0
    after = at + 3
    if _kind_at(tokens, after) == ":":
        if _kind_at(tokens, after + 1) not in ("UNUMBER", "UDECIMAL"):
            return None
        seconds, ns = tokens[after + 1].value, tokens[after + 1].ns
        after += 2
    if not iso and _kind_at(tokens, after) == "MERIDIAN":
        _set_time(parsed, hour, minutes, seconds, ns, tokens[after].value)
        return after + 1
    _set_time(parsed, hour, minutes, seconds, ns, _MER24)
    return _zone_offset(parsed, tokens, after)


def _iso_time(parsed: _Parsed, tokens: list[_Token], at: int) -> int | None:
    """The time after a date's ``T``: an hour with a numeric zone, or a
    clock.

    Args:
        parsed (_Parsed): the parse state.
        tokens (list[_Token]): the expression's tokens.
        at (int): just past the ``T``.
    """
    if _kind_at(tokens, at) != "UNUMBER":
        return None
    if _kind_at(tokens, at + 1) == ":":
        return _clock(parsed, tokens, at, True)
    if _kind_at(tokens, at + 1) != "SNUMBER":
        return None
    _set_time(parsed, tokens[at].value, 0, 0, 0, _MER24)
    return _zone_offset(parsed, tokens, at + 1)


def _digits_item(parsed: _Parsed, token: _Token) -> None:
    """A bare number, gnulib's digits_to_date_time: the year of a date
    that has none yet, a ``YYYYMMDD`` date past four digits, else
    ``HH`` or ``HHMM``.

    Args:
        parsed (_Parsed): the parse state.
        token (_Token): the number.
    """
    if (
        parsed.dates_seen
        and not parsed.year_digits
        and not parsed.rels_seen
        and (parsed.times_seen or token.digits > 2)
    ):
        parsed.year, parsed.year_digits = token.value, token.digits
    elif token.digits > 4:
        parsed.dates_seen += 1
        parsed.day = token.value % 100
        parsed.month = token.value // 100 % 100
        parsed.year = token.value // 10000
        parsed.year_digits = token.digits - 4
    elif token.digits <= 2:
        _set_time(parsed, token.value, 0, 0, 0, _MER24)
    else:
        _set_time(parsed, token.value // 100, token.value % 100, 0, 0, _MER24)


def _number_item(parsed: _Parsed, tokens: list[_Token], at: int) -> int | None:
    """An item that opens with an unsigned number, resolved by the token after
    it as gnulib's LALR(1) parser resolves it; with none that fits, a bare
    number.

    Args:
        parsed (_Parsed): the parse state.
        tokens (list[_Token]): the expression's tokens.
        at (int): the number's position.
    """
    number = tokens[at]
    after = _kind_at(tokens, at + 1)
    if after == "MERIDIAN":
        _set_time(parsed, number.value, 0, 0, 0, tokens[at + 1].value)
        return at + 2
    if after == ":":
        return _clock(parsed, tokens, at, False)
    if after == "/":
        if _kind_at(tokens, at + 2) != "UNUMBER":
            return None
        second = tokens[at + 2]
        parsed.dates_seen += 1
        if _kind_at(tokens, at + 3) != "/":
            parsed.month, parsed.day = number.value, second.value
            return at + 3
        if _kind_at(tokens, at + 4) != "UNUMBER":
            return None
        third = tokens[at + 4]
        if number.digits >= 4:
            parsed.year, parsed.year_digits = number.value, number.digits
            parsed.month, parsed.day = second.value, third.value
        else:
            parsed.month, parsed.day = number.value, second.value
            parsed.year, parsed.year_digits = third.value, third.digits
        return at + 5
    if after == "SNUMBER":
        following = _kind_at(tokens, at + 2)
        if following == "SNUMBER":
            parsed.year, parsed.year_digits = number.value, number.digits
            parsed.month = -tokens[at + 1].value
            parsed.day = -tokens[at + 2].value
            parsed.dates_seen += 1
            if _kind_at(tokens, at + 3) == "T":
                return _iso_time(parsed, tokens, at + 4)
            return at + 3
        if following in _UNITS:
            _digits_item(parsed, number)
            _apply(parsed, _unit_rel(tokens[at + 2], tokens[at + 1].value), 1)
            return at + 3
        _set_time(parsed, number.value, 0, 0, 0, _MER24)
        return _zone_offset(parsed, tokens, at + 1)
    if after == "MONTH":
        parsed.day, parsed.month = number.value, tokens[at + 1].value
        parsed.dates_seen += 1
        following = _kind_at(tokens, at + 2)
        if following == "SNUMBER":
            parsed.year = -tokens[at + 2].value
            parsed.year_digits = tokens[at + 2].digits
            return at + 3
        if following == "UNUMBER":
            parsed.year = tokens[at + 2].value
            parsed.year_digits = tokens[at + 2].digits
            return at + 3
        return at + 2
    if after == "DAY":
        parsed.day_ordinal = number.value
        parsed.day_number = tokens[at + 1].value
        parsed.days_seen += 1
        return at + 2
    if after in _UNITS:
        return _rel_item(parsed, tokens, at)
    _digits_item(parsed, number)
    return at + 1


def _item(parsed: _Parsed, tokens: list[_Token], at: int) -> int | None:
    """One item of gnulib's grammar at ``at``; where it ends, or None
    when the tokens there form none.

    Args:
        parsed (_Parsed): the parse state.
        tokens (list[_Token]): the expression's tokens.
        at (int): where the item starts.
    """
    token = tokens[at]
    kind = token.kind
    after = _kind_at(tokens, at + 1)
    if kind == "UNUMBER":
        return _number_item(parsed, tokens, at)
    if kind in ("SNUMBER", "UDECIMAL", "SDECIMAL") or kind in _UNITS:
        return _rel_item(parsed, tokens, at)
    if kind == "ORDINAL":
        if after == "DAY":
            parsed.day_ordinal = token.value
            parsed.day_number = tokens[at + 1].value
            parsed.days_seen += 1
            return at + 2
        return _rel_item(parsed, tokens, at)
    if kind == "DAY_SHIFT":
        _apply(parsed, _Rel(day=token.value), 1)
        return at + 1
    if kind == "MONTH":
        parsed.month = token.value
        parsed.dates_seen += 1
        if after == "SNUMBER":
            if _kind_at(tokens, at + 2) != "SNUMBER":
                return None
            parsed.day = -tokens[at + 1].value
            parsed.year = -tokens[at + 2].value
            parsed.year_digits = tokens[at + 2].digits
            return at + 3
        if after != "UNUMBER":
            return None
        parsed.day = tokens[at + 1].value
        if _kind_at(tokens, at + 2) != ",":
            return at + 2
        if _kind_at(tokens, at + 3) != "UNUMBER":
            return None
        parsed.year = tokens[at + 3].value
        parsed.year_digits = tokens[at + 3].digits
        return at + 4
    if kind == "DAY":
        parsed.day_ordinal, parsed.day_number = 0, token.value
        parsed.days_seen += 1
        return at + 2 if after == "," else at + 1
    if kind in ("ZONE", "T"):
        zone = -7 * _HOUR if kind == "T" else token.value
        parsed.time_zone = zone
        parsed.zones_seen += 1
        if after == "SNUMBER" and _kind_at(tokens, at + 2) in _UNITS:
            _apply(parsed, _unit_rel(tokens[at + 2], tokens[at + 1].value), 1)
            return at + 3
        if kind == "T":
            return at + 1
        if after == "DST":
            parsed.time_zone = zone + _HOUR
            return at + 2
        if after != "SNUMBER":
            return at + 1
        found = _zone_hhmm(tokens, at + 1)
        if found is None:
            return None
        parsed.time_zone += found[0]
        return found[1]
    if kind == "DAYZONE":
        parsed.time_zone = token.value + _HOUR
        parsed.zones_seen += 1
        return at + 1
    if kind == "LOCAL_ZONE":
        parsed.local_zones_seen += 1
        parsed.local_offset = token.offset
        if after == "DST":
            parsed.dsts_seen += 1
            parsed.local_offset = (
                None if token.offset is None else token.offset + _HOUR
            )
            return at + 2
        return at + 1
    if kind == "J":
        parsed.j_zones_seen += 1
        return at + 1
    return None


def _to_hour(hour: int, meridian: int) -> int:
    """An hour on the 24-hour clock, -1 when the meridian refuses it.

    Args:
        hour (int): the hour as written.
        meridian (int): _MER24, _AM or _PM.
    """
    if meridian == _MER24:
        return hour if 0 <= hour < 24 else -1
    if not 0 < hour <= 12:
        return -1
    return hour % 12 + (12 if meridian == _PM else 0)


def _normalized(year: int, month: int, day: int, clock: datetime) -> datetime:
    """A wall clock from fields that may overflow, normalized the way
    mktime carries them: months into years, days across months.

    Args:
        year (int): the year.
        month (int): the month, 1-based, any integer.
        day (int): the day of the month, any integer.
        clock (datetime): whose time of day the result keeps.
    """
    year += (month - 1) // 12
    month = (month - 1) % 12 + 1
    first = datetime(year, month, 1, clock.hour, clock.minute, clock.second)
    return first + timedelta(days=day - 1)


def _fixed(wall: datetime, offset: int) -> float:
    """The epoch second a wall clock is at a fixed offset east of UTC.

    Args:
        wall (datetime): the naive wall clock.
        offset (int): seconds east of UTC.
    """
    return wall.replace(tzinfo=timezone.utc).timestamp() - offset


def _offset_seconds(moment: datetime) -> int | None:
    """A moment's offset east of UTC in seconds, None when naive.

    Args:
        moment (datetime): the moment.
    """
    offset = moment.utcoffset()
    return None if offset is None else int(offset.total_seconds())


def _local_reading(wall: datetime, tz: tzinfo, offset: int) -> datetime | None:
    """The reading of a wall clock that carries a local abbreviation's
    offset, None when the zone does not show the wall clock under it
    (``CET`` on a summer date in Europe/Berlin), as mktime refuses a
    tm_isdst that does not hold.

    Args:
        wall (datetime): the naive wall clock.
        tz (tzinfo): the reading zone.
        offset (int): the abbreviation's seconds east of UTC.
    """
    for fold in (0, 1):
        reading = wall.replace(tzinfo=tz, fold=fold)
        shown = reading.astimezone(timezone.utc).astimezone(tz)
        held = reading.utcoffset()
        if (
            shown.replace(tzinfo=None) == wall
            and held is not None
            and int(held.total_seconds()) == offset
        ):
            return reading
    return None


def _held(wall: datetime, tz: tzinfo, offset: int) -> datetime:
    """A wall clock as mktime reads it under an explicit tm_isdst: the
    reading at that offset, or the wall clock taken at the offset where
    the zone does not show it under it, which is how mktime extrapolates
    a tm_isdst the date does not observe.

    Args:
        wall (datetime): the naive wall clock.
        tz (tzinfo): the reading zone.
        offset (int): the tm_isdst's seconds east of UTC.
    """
    reading = _local_reading(wall, tz, offset)
    if reading is not None:
        return reading
    return datetime.fromtimestamp(_fixed(wall, offset), tz)


def _resolve(
    parsed: _Parsed, tz: tzinfo | None, now: datetime
) -> datetime | None:
    """The moment the parsed items name, gnulib's parse_datetime body: the
    fields placed in the zone as mktime places them, a weekday moved to, then
    the summed relative days moved on the calendar once and the relative
    seconds added on the timeline.

    Args:
        parsed (_Parsed): the parse state.
        tz (tzinfo | None): the reading zone, None for the host's.
        now (datetime): the current moment in ``tz``.
    """
    if 1 < (
        parsed.times_seen
        | parsed.dates_seen
        | parsed.days_seen
        | parsed.dsts_seen
        | (parsed.j_zones_seen + parsed.local_zones_seen + parsed.zones_seen)
    ):
        return None
    year = parsed.year
    if parsed.year_digits == 2 and 0 <= year:
        year += 2000 if year < 69 else 1900
    absolute = bool(parsed.dates_seen or parsed.days_seen or parsed.times_seen)
    if parsed.times_seen or (parsed.rels_seen and not absolute):
        hour = _to_hour(parsed.hour, parsed.meridian)
        minute, second, ns = parsed.minutes, parsed.seconds, parsed.ns
    else:
        hour, minute, second, ns = 0, 0, 0, 0
    if not (
        1 <= year <= 9999
        and 1 <= parsed.month <= 12
        and 0 <= hour <= 23
        and 0 <= minute <= 59
        and 0 <= second <= 59
    ):
        return None
    if not 1 <= parsed.day <= monthrange(year, parsed.month)[1]:
        return None
    wall = datetime(year, parsed.month, parsed.day, hour, minute, second)
    rel = parsed.rel
    if parsed.zones_seen or tz is None:
        if parsed.days_seen and not parsed.dates_seen:
            wall += timedelta(days=_weekday_shift(parsed, wall))
        if rel.year or rel.month or rel.day:
            wall = _normalized(
                wall.year + rel.year,
                wall.month + rel.month,
                wall.day + rel.day,
                wall,
            )
        if not parsed.zones_seen:
            moment = wall.replace(microsecond=ns // 1000)
            return moment + timedelta(
                hours=rel.hour,
                minutes=rel.minutes,
                seconds=rel.seconds,
                microseconds=rel.ns // 1000,
            )
        epoch = _fixed(wall, parsed.time_zone)
    else:
        # What gnulib hands mktime as tm_isdst for the calendar move: -1
        # (None here) after a date, weekday or time, else an explicit
        # one, the local abbreviation's or the current moment's, which
        # mktime holds to even where the moved date does not observe it.
        hint = (
            parsed.local_offset
            if parsed.local_zones_seen
            else None
            if absolute
            else _offset_seconds(now)
        )
        if parsed.local_zones_seen and parsed.local_offset is not None:
            placed = _local_reading(wall, tz, parsed.local_offset)
        elif absolute or hint is None:
            placed = _localize(wall, tz)
        else:
            placed = _held(wall, tz, hint)
        if placed is None:
            return None
        if parsed.days_seen and not parsed.dates_seen:
            shown = placed.replace(tzinfo=None)
            moved = shown + timedelta(days=_weekday_shift(parsed, shown))
            placed = _place(moved, tz, placed.utcoffset())
        if rel.year or rel.month or rel.day:
            shown = placed.replace(tzinfo=None)
            moved = _normalized(
                shown.year + rel.year,
                shown.month + rel.month,
                shown.day + rel.day,
                wall,
            )
            placed = (
                _place(moved, tz, placed.utcoffset())
                if hint is None
                else _held(moved, tz, hint)
            )
        epoch = placed.timestamp()
    seconds = epoch + rel.hour * _HOUR + rel.minutes * 60 + rel.seconds
    total_ns = ns + rel.ns
    seconds += total_ns // _BILLION
    micros = total_ns % _BILLION // 1000
    if not _FIRST_SECOND <= seconds <= _LAST_SECOND:
        return None
    moment = datetime.fromtimestamp(seconds, timezone.utc).astimezone(tz)
    return moment.replace(microsecond=micros)


def _weekday_shift(parsed: _Parsed, base: datetime) -> int:
    """Days from ``base`` to the weekday the items name: on or after ``base``,
    ``next`` or a count skipping more weeks, ``last`` going back.

    Args:
        parsed (_Parsed): the parse state.
        base (datetime): the wall clock to move from.
    """
    weekday = (base.weekday() + 1) % 7
    ordinal = parsed.day_ordinal - (
        1 if parsed.day_ordinal > 0 and weekday != parsed.day_number else 0
    )
    return ordinal * 7 + (parsed.day_number - weekday + 7) % 7


def _tz_prefix(text: str) -> tuple[str, str] | None:
    """A leading ``TZ="..."``: the zone it names and the text after it,
    with ``\\`` and ``"`` escaped by a backslash inside the quotes.

    Args:
        text (str): the expression, leading blanks removed.
    """
    if not text.startswith('TZ="'):
        return None
    name: list[str] = []
    at = 4
    while at < len(text):
        char = text[at]
        if char == "\\" and at + 1 < len(text) and text[at + 1] in '\\"':
            name.append(text[at + 1])
            at += 2
            continue
        if char == '"':
            return "".join(name), text[at + 1 :]
        name.append(char)
        at += 1
    return None


def parse_date_expr(
    text: str, *, tz: tzinfo | None = None, now: datetime | None = None
) -> datetime | None:
    """Parse a GNU ``date -d`` expression, None when GNU says ``invalid date``.
    A port of gnulib's parse-datetime grammar as coreutils 9.7 builds it; one
    divergence: a moment outside years 1-9999 is not a date, the range
    ``datetime`` holds.

    Args:
        text (str): the -d argument as typed.
        tz (tzinfo | None): the zone the result is read and rendered
            in: UTC under ``-u``, the zone ``TZ`` names, or None for
            the host's local zone, which keeps the result naive.
        now (datetime | None): the current moment, injectable for tests.
    """
    raw = text.lstrip(_SPACES)
    reading = tz
    prefixed = _tz_prefix(raw)
    if prefixed is not None:
        reading = resolve_tz(prefixed[0])
        raw = prefixed[1]
    raw = raw.strip(_SPACES)
    if raw.startswith("@"):
        # gnulib's epoch grammar (findutils 4.10): blanks, a sign, a
        # decimal count of seconds and a fraction with digits on both
        # sides; `@0x1`, `@1e2`, `@1.` and `@.5` are not dates, however
        # readily float() would take them.
        if _EPOCH_RE.fullmatch(raw) is None:
            return None
        return datetime.fromtimestamp(float(raw[1:]), tz=tz)
    if now is None:
        now = datetime.now(reading)
    elif reading is not None:
        now = (
            now.astimezone(reading)
            if now.tzinfo
            else now.replace(tzinfo=reading)
        )
    tokens = _lex(raw, _local_zones(reading, now))
    if tokens is None:
        return None
    parsed = _Parsed(
        year=now.year,
        year_digits=0,
        month=now.month,
        day=now.day,
        hour=now.hour,
        minutes=now.minute,
        seconds=now.second,
        ns=now.microsecond * 1000,
    )
    at = 0
    while at < len(tokens):
        after = _item(parsed, tokens, at)
        if after is None:
            return None
        at = after
    try:
        moment = _resolve(parsed, reading, now)
    except (OverflowError, ValueError, OSError):
        return None
    if moment is None or reading is tz:
        return moment
    return moment.astimezone(tz)


def _place(wall: datetime, tz: tzinfo, offset: timedelta | None) -> datetime:
    """Put a displaced wall clock back on the timeline, the way mktime
    does when gnulib hands it the base moment's ``tm_isdst``.

    A wall clock the zone shows once is that instant. One it shows
    twice (the hour repeated when DST ends) is the reading under the
    base's offset, so a summer base stays in summer time and a winter
    one in winter time, else the later reading. One it never shows
    (the hour skipped when DST starts) is read under the offset in
    force before the change and lands past the gap whichever side the
    base was on: ``2025-03-29 02:30 CET 1 day`` and ``2025-03-31 02:30
    CEST 1 day ago`` are both ``03:30 CEST`` under GNU.

    Args:
        wall (datetime): the naive wall clock after the displacement.
        tz (tzinfo): the zone it is read in.
        offset (timedelta | None): the base moment's UTC offset.
    """
    first = wall.replace(tzinfo=tz, fold=0)
    second = wall.replace(tzinfo=tz, fold=1)
    shown = [
        reading
        for reading in (first, second)
        if reading.astimezone(timezone.utc).astimezone(tz).replace(tzinfo=None)
        == wall
    ]
    if not shown:
        return first.astimezone(timezone.utc).astimezone(tz)
    if first.utcoffset() == second.utcoffset():
        return first
    for reading in shown:
        if reading.utcoffset() == offset:
            return reading
    return second


def _localize(dt: datetime, tz: tzinfo | None) -> datetime | None:
    """Place a parsed moment on the timeline the caller reads in.

    A moment carrying its own zone is converted; a naive one is read
    as a wall clock in ``tz``, or stays naive (host local) when there
    is none, which is how GNU reads ``-d '2026-01-01 00:00'`` under a
    ``TZ``. Two wall clocks a zone does not show once are read as
    glibc's mktime reads them: the hour repeated when DST ends is the
    later (standard-time) instant, and the hour skipped when it starts
    is no moment at all, GNU's ``invalid date``.

    Args:
        dt (datetime): the parsed moment.
        tz (tzinfo | None): the zone, None for the host's local zone.

    Returns:
        datetime | None: the moment, or None for a skipped wall clock.
    """
    if dt.tzinfo is not None:
        return dt.astimezone(tz)
    if tz is None:
        return dt
    placed = dt.replace(tzinfo=tz, fold=1)
    shown = placed.astimezone(timezone.utc).astimezone(tz)
    if shown.replace(tzinfo=None) != dt:
        return None
    return placed


def parse_posix_time(
    text: str, *, tz: tzinfo | None = None, now: datetime | None = None
) -> datetime | None:
    """Parse the ``MMDDhhmm[[CC]YY][.ss]`` a bare ``date`` operand is.

    gnulib's posixtime with date's syntax bits, measured on coreutils
    9.7: no year is this year, a two-digit one is 2000-2068 up to 68
    and 1969-1999 from 69, and ``.ss`` takes exactly two digits. A
    field out of range (``1301000024``, ``01012500``) is not a date,
    nor is a wall clock ``tz`` skips; second 60 is the next minute's
    first, as mktime reads a leap second. One divergence: GNU shows
    year 0 and year 10000, where mirage holds what ``datetime`` holds,
    so a year 0 operand, a UTC moment outside years 1-9999 and the
    leap second after 9999-12-31 23:59:59 are not a date either.

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
        return placed + timedelta(seconds=leap)
    except (OverflowError, ValueError):
        return None


def utc_date_folder(ts: float | None = None) -> str:
    t = (
        datetime.now(timezone.utc)
        if ts is None
        else datetime.fromtimestamp(ts, timezone.utc)
    )
    return t.strftime("%Y-%m-%d")


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


def matches_mtime(
    value: str | None, mtime_min: float | None, mtime_max: float | None
) -> bool:
    return in_mtime_window(iso_timestamp(value), mtime_min, mtime_max)


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
