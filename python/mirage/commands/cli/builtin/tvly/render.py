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

# Plain-text rendering adapted from tvly 1.0.2's src/ui/text.ts and
# src/ui/render/ (MIT; see licenses/third_party/tavily-cli.txt): the
# output tvly prints when stdout is not a terminal, which an agent's
# shell never is.

import math
import re

import orjson

from mirage.core.render.json import ecma_numbers, number_text
from mirage.types import JsonValue

CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]")
BLANK_RUNS = re.compile(r"\n(?:[ \t]*\n){2,}")
JS_SPACE = "".join(
    map(
        chr,
        (0x9, 0xA, 0xB, 0xC, 0xD, 0x20, 0xA0, 0x1680)
        + tuple(range(0x2000, 0x200B))
        + (0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF),
    )
)
SPACE_RUN = re.compile(f"[{re.escape(JS_SPACE)}]+")


def js_text(value: JsonValue) -> str:
    """``String(value)`` for a decoded JSON value.

    Args:
        value (JsonValue): the value.
    """
    if isinstance(value, str):
        return value
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        if math.isnan(value):
            return "NaN"
        if math.isinf(value):
            return "Infinity" if value > 0 else "-Infinity"
        return number_text(float(value))
    if isinstance(value, list):
        return ",".join(
            "" if item is None else js_text(item) for item in value
        )
    return "[object Object]"


def truthy(value: JsonValue) -> bool:
    """Whether JavaScript reads ``value`` as true.

    Args:
        value (JsonValue): the value.
    """
    if isinstance(value, (dict, list)):
        return True
    if isinstance(value, float) and math.isnan(value):
        return False
    return bool(value)


def js_trim(text: str) -> str:
    """``String.prototype.trim``: strips JavaScript's whitespace set.

    Args:
        text (str): the text.
    """
    return text.strip(JS_SPACE)


def utf16_slice(text: str, units: int) -> str:
    """``text.slice(0, units)`` counted in UTF-16 code units, a pair cut
    in half ending in the U+FFFD a JavaScript runtime writes for it.

    Args:
        text (str): the text.
        units (int): how many UTF-16 code units to keep.
    """
    raw = text.encode("utf-16-le", "surrogatepass")[: units * 2]
    if len(raw) >= 2 and 0xD8 <= raw[-1] <= 0xDB:
        return raw[:-2].decode("utf-16-le") + "�"
    return raw.decode("utf-16-le")


def utf16_length(text: str) -> int:
    """``text.length``: UTF-16 code units.

    Args:
        text (str): the text.
    """
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def sanitize_control(value: JsonValue) -> str:
    """Drop C0 controls but tab, newline and return, plus DEL and C1.

    Args:
        value (JsonValue): the value, spelled as ``String`` spells it.
    """
    return CONTROL_CHARS.sub("", js_text(value))


def plain(value: JsonValue) -> str:
    """Sanitized, blank-line runs folded to one, trimmed.

    Args:
        value (JsonValue): the value.
    """
    return js_trim(BLANK_RUNS.sub("\n\n", sanitize_control(value)))


def snippet(content: JsonValue, max_chars: int) -> str:
    """Content on one line, cut at ``max_chars`` with an ellipsis.

    Args:
        content (JsonValue): the content.
        max_chars (int): the most characters to keep; 0 keeps all.
    """
    text = " ".join(
        part for part in SPACE_RUN.split(sanitize_control(content)) if part
    )
    if max_chars and utf16_length(text) > max_chars:
        return f"{utf16_slice(text, max_chars)}..."
    return text


def items(value: JsonValue) -> list[JsonValue]:
    """The value when it is a list, else nothing.

    Args:
        value (JsonValue): the value.
    """
    return value if isinstance(value, list) else []


def field(value: JsonValue, name: str) -> JsonValue:
    """``value[name]``, None when ``value`` is no object or lacks it.

    Args:
        value (JsonValue): the value.
        name (str): the key.
    """
    return value.get(name) if isinstance(value, dict) else None


def member_text(value: JsonValue, name: str) -> str:
    """``String(value[name])``: ``undefined`` when the key is missing.

    Args:
        value (JsonValue): the object.
        name (str): the key.
    """
    if not isinstance(value, dict) or name not in value:
        return "undefined"
    return js_text(value[name])


def json_text(value: JsonValue, pretty: bool) -> str:
    """``JSON.stringify(value)``, two-space indented when ``pretty``.

    Args:
        value (JsonValue): the value.
        pretty (bool): whether to indent.
    """
    option = orjson.OPT_INDENT_2 if pretty else 0
    return orjson.dumps(ecma_numbers(value), option=option).decode()


def pages_text(pages: list[JsonValue]) -> str:
    """Each page as ``# <url>``, a blank line, and its whole content.

    Args:
        pages (list[JsonValue]): the API's result pages.
    """
    out = []
    for page in pages:
        url = field(page, "url")
        content = field(page, "raw_content")
        out.append(f"# {plain('' if url is None else url)}\n\n")
        body = content if truthy(content) else "(no content)"
        out.append(f"{plain(body)}\n\n")
    return "".join(out)
