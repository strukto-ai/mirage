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
from collections.abc import Callable
from typing import Any

from mirage.types import FileStat, JsonValue

logger = logging.getLogger(__name__)

_MAX_SIZE = 2**53 - 1
_MAX_DIGITS = 16
_DIGITS = re.compile(r"[0-9]+")


def reported_size(value: JsonValue) -> int | None:
    """The byte size a backend reply reports, or None when it is not one.

    Replies spell a size as a JSON number or as a decimal string (Google
    Drive). Only a non-negative integer that both hosts read exactly
    counts: an int (not a bool), an integral float, or a string of ASCII
    digits, each at most ``2**53 - 1``. The length check comes before
    ``int()``, which refuses very long strings. Anything else is None, so
    a caller falls back to the bytes it sent.

    Args:
        value (JsonValue): the reply's size field.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        number = value
    elif isinstance(value, float):
        if not value.is_integer():
            return None
        number = int(value)
    elif isinstance(value, str):
        if len(value) > _MAX_DIGITS or _DIGITS.fullmatch(value) is None:
            return None
        number = int(value)
    else:
        return None
    if number < 0 or number > _MAX_SIZE:
        return None
    return number


def upload_receipt(
    item: JsonValue,
    stat_of: Callable[[dict[str, Any]], FileStat],
    sent: int,
    virtual: str,
) -> tuple[int, str | None]:
    """The stored size and token an upload reply names for a write.

    ``item`` is the stored file's metadata as the backend answered it.
    The size is :func:`reported_size` of its ``size`` field, else
    ``sent``; the token is what ``stat_of`` (the backend's own stat
    parser, so the write's token is the kind its ``stat`` reports) reads
    from it, and only when the reply reports a size. The upload has
    landed by now, so nothing here raises: a reply that is not a JSON
    object answers ``(sent, None)``, and a parser that fails keeps the
    reported size and drops just the token, so a stored size other than
    ``sent`` still reaches the cache's size check.

    Args:
        item (JsonValue): the stored file's metadata from the reply.
        stat_of (Callable[[dict[str, Any]], FileStat]): the backend's stat
            parser for that metadata.
        sent (int): the number of bytes uploaded.
        virtual (str): the written path, for the debug log.
    """
    if not isinstance(item, dict):
        return sent, None
    size = reported_size(item.get("size"))
    if size is None:
        return sent, None
    try:
        token = stat_of(item).fingerprint or None
    except Exception as exc:
        logger.debug("unreadable upload reply for %s: %s", virtual, exc)
        token = None
    return size, token
