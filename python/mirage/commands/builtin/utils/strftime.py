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

from mirage.rs.stream import open_stream
from mirage.shell.bytes import decode_text, encode_text


def winning_pad(flags: str) -> str | None:
    """The last padding flag, also used by Git's libc-style formatter.

    Args:
        flags (str): flags between the percent sign and the width.
    """
    return next((ch for ch in reversed(flags) if ch in "-_0+"), None)


def gnu_strftime(dt: datetime, fmt: str, years: int = 0) -> str:
    """Render GNU date's C-locale directives through the shared Rust engine.

    The host supplies one timezone reading, including the epoch and offset;
    Rust owns the calendar, directives and padding. A naive moment uses the
    local zone. Git can restore whole Gregorian cycles to an extended year.

    Args:
        dt (datetime): the moment being rendered.
        fmt (str): the format without a leading plus sign.
        years (int): whole 400-year cycles to add to the displayed year.
    """
    if dt.utcoffset() is None:
        dt = dt.astimezone()
    offset = dt.utcoffset()
    stream = open_stream(
        "strftime",
        {
            "year": dt.year + years,
            "month": dt.month,
            "day": dt.day,
            "hour": dt.hour,
            "minute": dt.minute,
            "second": dt.second,
            "nanosecond": dt.microsecond * 1000,
            "epoch": math.floor(dt.timestamp()),
            "offset": round(offset.total_seconds())
            if offset is not None
            else 0,
            "zone": dt.tzname() or "",
        },
    )
    stream.feed(encode_text(fmt))
    return decode_text(stream.finish())
