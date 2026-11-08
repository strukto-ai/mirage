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
from datetime import datetime

from mirage.commands.builtin.utils.stream import stream_output
from mirage.io.stream import OutputStream
from mirage.rs.stream import open_stream
from mirage.shell.bytes import decode_text, encode_text
from mirage.types import JsonValue


def winning_pad(flags: str) -> str | None:
    """The last padding flag, also used by Git's libc-style formatter.

    Args:
        flags (str): flags between the percent sign and the width.
    """
    return next((ch for ch in reversed(flags) if ch in "-_0+"), None)


def _config(
    dt: datetime, years: int, nanosecond: int | None
) -> dict[str, JsonValue]:
    """The strftime engine's reading of one moment.

    Args:
        dt (datetime): the moment; a naive one is in the local zone.
        years (int): whole 400-year cycles to add to the displayed year.
        nanosecond (int | None): the second's nanoseconds, finer than a
            datetime holds; the moment's own microseconds when None.
    """
    if dt.utcoffset() is None:
        dt = dt.astimezone()
    offset = dt.utcoffset()
    return {
        "year": dt.year + years,
        "month": dt.month,
        "day": dt.day,
        "hour": dt.hour,
        "minute": dt.minute,
        "second": dt.second,
        "nanosecond": dt.microsecond * 1000
        if nanosecond is None
        else nanosecond,
        "epoch": math.floor(dt.timestamp()),
        "offset": round(offset.total_seconds()) if offset is not None else 0,
        "zone": dt.tzname() or "",
    }


def gnu_strftime(
    dt: datetime, fmt: str, years: int = 0, nanosecond: int | None = None
) -> str:
    """Render date's C-locale directives through the shared Rust engine.

    The host supplies one timezone reading, including the epoch and offset;
    Rust owns the calendar, directives and padding. A naive moment uses the
    local zone. Git can restore whole Gregorian cycles to an extended year.

    Args:
        dt (datetime): the moment being rendered.
        fmt (str): the format without a leading plus sign.
        years (int): whole 400-year cycles to add to the displayed year.
        nanosecond (int | None): the second's nanoseconds, finer than a
            datetime holds; the moment's own microseconds when None.
    """
    stream = open_stream("strftime", _config(dt, years, nanosecond))
    stream.feed(encode_text(fmt))
    parts = [stream.finish()]
    while stream.busy():
        parts.append(stream.drain())
    return decode_text(b"".join(parts))


def strftime_stream(
    dt: datetime, fmt: str, nanosecond: int | None = None
) -> OutputStream:
    """`gnu_strftime` as output, a window at a time, so a field as wide as
    date allows is written as date writes it rather than held.

    Args:
        dt (datetime): the moment being rendered.
        fmt (str): the format without a leading plus sign.
        nanosecond (int | None): the second's nanoseconds; the moment's
            own microseconds when None.
    """
    stream = open_stream("strftime", _config(dt, 0, nanosecond))
    return stream_output(stream, encode_text(fmt))
