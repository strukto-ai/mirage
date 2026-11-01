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

import json
from typing import Any

from mirage.rs.document import from_units
from mirage.rs.stream import open_stream
from mirage.types import JsonValue

# POSIX NAME_MAX on ext4 and APFS alike, and it counts BYTES. Truncating by
# characters is the same number only for ASCII: a 100-character CJK title is
# 300 bytes.
NAME_MAX_BYTES = 255
# What ``/`` becomes inside a path segment: U+2215 DIVISION SLASH, the one
# character every backend renders a slash as, so a value cannot open a
# directory boundary. ``core.hierarchy.codec`` is what inverts it.
SAFE_SLASH = "∕"
# What marks the next character of a path segment as literal: U+2044
# FRACTION SLASH. ``path_safe_name`` leads a dot-led name with it, since the
# hierarchy hides a dot-led segment, and ``core.hierarchy.codec`` spells its
# reversible encoding with it.
ESCAPE_LEAD = "⁄"


def _sanitize(text: str, config: dict[str, JsonValue]) -> Any:
    """Answer one of mirage-rs's filename rules.

    Args:
        text (str): the text, sent as code points so a lone surrogate
            arrives whole.
        config (dict[str, JsonValue]): the rule and its budgets.
    """
    rule: dict[str, JsonValue] = {**config, "text": list(map(ord, text))}
    return json.loads(open_stream("sanitize", rule).finish())


def is_blank(text: str) -> bool:
    """Whether the text is empty or nothing but Unicode White_Space.

    Args:
        text (str): the string to test.
    """
    return _sanitize(text, {"op": "blank"}) is True


def byte_length(text: str) -> int:
    """Measure a string the way the filesystem does, in UTF-8 bytes.

    Args:
        text (str): the string to measure.
    """
    return len(text.encode("utf-8", "surrogatepass"))


def truncate_bytes(text: str, budget: int) -> str:
    """Trim a string to fit a byte budget without splitting a character.

    Args:
        text (str): the string to trim.
        budget (int): maximum length in UTF-8 bytes.
    """
    return from_units(_sanitize(text, {"op": "truncate", "budget": budget}))


def sanitize_name(name: str) -> str:
    """Sanitize a name for use in virtual paths.

    Replaces shell-unsafe characters and spaces with underscores, so the
    name needs no quoting. Never dot-led, never empty (``unknown``), at
    most 100 characters.

    Args:
        name (str): raw name from API.
    """
    return from_units(_sanitize(name, {"op": "name"}))


def path_safe_name(name: str) -> str:
    """Make a name safe to embed in a VFS path segment.

    Keeps the original spelling, replaces ``/`` with ``SAFE_SLASH`` and
    leads a dot-led name with ``ESCAPE_LEAD``, since the hierarchy hides
    a dot-led segment. A blank name is ``unknown``.

    Args:
        name (str): raw name from API.
    """
    return from_units(_sanitize(name, {"op": "path"}))


def sanitize_label(
    text: str, *, fallback: str, max_len: int, max_bytes: int = NAME_MAX_BYTES
) -> str:
    """Sanitize an API-supplied label for use inside a filename.

    As ``sanitize_name``, but ellipsized past either budget, so a
    truncated name reads as truncated. ``max_len`` is the readable length
    a backend wants and ``max_bytes`` what the filesystem accepts; pass
    the bytes the rest of the filename does not already use.

    Args:
        text (str): raw label from the API.
        fallback (str): what a blank or wholly unsafe label becomes.
        max_len (int): budget in characters, including the ellipsis.
        max_bytes (int): budget in UTF-8 bytes for the label alone.
    """
    return from_units(
        _sanitize(
            text,
            {
                "op": "label",
                "fallback": fallback,
                "max_len": max_len,
                "max_bytes": max_bytes,
            },
        )
    )
