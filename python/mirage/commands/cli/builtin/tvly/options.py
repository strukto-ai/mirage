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

# Option values are checked as tvly 1.0.2's src/commands/options.ts and
# src/core/search-flags.ts check them, and refused in commander 15's
# words, which tvly answers every usage error in (MIT; see
# licenses/third_party/tavily-cli.txt).

import math
import re

from mirage.commands.cli.builtin.tvly.render import js_trim
from mirage.commands.spec.flag_view import FlagView
from mirage.core.render.json import number_text
from mirage.types import JsonValue

DECIMAL = re.compile(r"[+-]?(?:(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|Infinity)")
RADIX = re.compile(r"0(?:[xX][0-9a-fA-F]+|[oO][0-7]+|[bB][01]+)")
# The least integer a double rounds up to Infinity.
FLOAT_OVERFLOW = 2**1024 - 2**970


class InvalidOption(Exception):
    """An option value tvly refuses, worded as commander words it.

    Args:
        flags (str): the option as its help spells it, ``--max-results
            <n>``.
        raw (str): the value the line gave.
        reason (str): why it is refused, a full sentence.
    """

    def __init__(self, flags: str, raw: str, reason: str) -> None:
        super().__init__(
            f"error: option '{flags}' argument '{raw}' is invalid. {reason}"
        )


def js_number(raw: str) -> float:
    """``Number(raw)``: NaN for text JavaScript does not read as one.

    Args:
        raw (str): the text.
    """
    text = js_trim(raw)
    if text == "":
        return 0.0
    if DECIMAL.fullmatch(text):
        return float(text.replace("Infinity", "inf"))
    if RADIX.fullmatch(text):
        whole = int(text, 0)
        return math.inf if whole >= FLOAT_OVERFLOW else float(whole)
    return math.nan


def parse_number(
    raw: str,
    flags: str,
    *,
    integer: bool = False,
    minimum: float | None = None,
    maximum: float | None = None,
) -> int | float:
    """A numeric option value, refused as tvly refuses it.

    Args:
        raw (str): the value the line gave.
        flags (str): the option as its help spells it.
        integer (bool): whether it must be whole.
        minimum (float | None): the smallest it may be.
        maximum (float | None): the largest it may be.

    Raises:
        InvalidOption: it is not a number, not whole, or out of range.
    """
    n = math.nan if js_trim(raw) == "" else js_number(raw)
    if math.isnan(n):
        raise InvalidOption(flags, raw, "Not a number.")
    whole = math.isfinite(n) and n == math.floor(n)
    if integer and not whole:
        raise InvalidOption(flags, raw, "Not an integer.")
    if minimum is not None and n < minimum:
        raise InvalidOption(
            flags, raw, f"{_spell(n)} is below the minimum {_spell(minimum)}."
        )
    if maximum is not None and n > maximum:
        raise InvalidOption(
            flags, raw, f"{_spell(n)} is above the maximum {_spell(maximum)}."
        )
    return int(n) if whole and abs(n) < 2**53 else n


def _spell(n: float) -> str:
    if math.isinf(n):
        return "Infinity" if n > 0 else "-Infinity"
    return number_text(float(n))


def check_choice(raw: str, flags: str, choices: tuple[str, ...]) -> str:
    """A value one of ``choices`` must be, refused as commander does.

    Args:
        raw (str): the value the line gave.
        flags (str): the option as its help spells it.
        choices (tuple[str, ...]): what it may be.

    Raises:
        InvalidOption: it is none of them.
    """
    if raw not in choices:
        raise InvalidOption(
            flags, raw, f"Allowed choices are {', '.join(choices)}."
        )
    return raw


def split_csv(value: str | None) -> list[JsonValue] | None:
    """A comma-separated value as its parts, each trimmed.

    Args:
        value (str | None): the value; empty or absent is None.
    """
    if not value:
        return None
    parts: list[JsonValue] = [js_trim(part) for part in value.split(",")]
    return parts


def typed_number(
    fl: FlagView,
    name: str,
    flags: str,
    *,
    integer: bool = False,
    default: int | None = None,
) -> int | float | None:
    """A numeric option, checked at each place the line typed it.

    Args:
        fl (FlagView): the line's flags.
        name (str): the option's dest.
        flags (str): the option as its help spells it.
        integer (bool): whether it must be whole.
        default (int | None): what an absent option reads as.

    Raises:
        InvalidOption: one of its values is refused.
    """
    value: int | float | None = default
    for _, raw in fl.texts(name):
        value = parse_number(raw, flags, integer=integer)
    return value


def typed_choice(
    fl: FlagView, name: str, flags: str, choices: tuple[str, ...]
) -> str | None:
    """A choice option, checked at each place the line typed it.

    Args:
        fl (FlagView): the line's flags.
        name (str): the option's dest.
        flags (str): the option as its help spells it.
        choices (tuple[str, ...]): what it may be.

    Raises:
        InvalidOption: one of its values is refused.
    """
    value = None
    for _, raw in fl.texts(name):
        value = check_choice(raw, flags, choices)
    return value


def client_name_of(fl: FlagView) -> str | None:
    """The ``--client-name`` the line gave, or ``TAVILY_CLIENT_NAME``; an
    empty one is none.

    Args:
        fl (FlagView): the line's flags.
    """
    return fl.as_str("client_name") or None


def defined(body: dict[str, JsonValue], key: str, value: JsonValue) -> None:
    """Set ``key`` when the line gave a value for it.

    Args:
        body (dict[str, JsonValue]): the request body being built.
        key (str): its API name.
        value (JsonValue): the value; None leaves the key out.
    """
    if value is not None:
        body[key] = value
