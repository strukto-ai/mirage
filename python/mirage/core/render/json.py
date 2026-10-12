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
import math
from typing import Any

import orjson


def json_text(value: Any) -> str:
    """Render a value as indented JSON text.

    Args:
        value (Any): the JSON-serializable payload to render.
    """
    return json.dumps(value, ensure_ascii=False, indent=2)


def json_bytes(value: Any) -> bytes:
    """Render a value as an indented .json body.

    Every backend renders a .json leaf through here, so read() and the
    readdir-time sizing produce the same bytes for the same payload and
    the advertised size is exact by construction.

    Args:
        value (Any): the JSON-serializable payload to render.
    """
    return json_text(value).encode()


def compact_json_text(value: Any) -> str:
    """Render a value as a single line of JSON.

    Args:
        value (Any): the JSON-serializable payload to render.
    """
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def compact_json_bytes(value: Any) -> bytes:
    """Render a value as a single-line JSON body.

    Args:
        value (Any): the JSON-serializable payload to render.
    """
    return compact_json_text(value).encode()


def number_text(value: float) -> str:
    """Spell a float the way ECMAScript's ``Number::toString`` does.

    Python's ``repr`` and V8 agree on the shortest round-trip digits and
    differ only on layout: Python switches to an exponent below 1e-4 and
    from 1e16 and pads it to two digits (``1e-05``, ``1e+16``), where
    ECMAScript switches below 1e-6 and from 1e21 and pads nothing
    (``0.00001``, ``10000000000000000``, ``1e-7``, ``1e+21``), and an
    integral value drops its ``.0``. A non-finite value has no JSON
    spelling and renders ``null``, as ``JSON.stringify`` does. The
    typescript twin is ``String()`` itself.

    Args:
        value (float): the number to spell.
    """
    if not math.isfinite(value):
        return "null"
    if value == 0:
        return "0"
    sign = "-" if value < 0 else ""
    mantissa, _, exponent = repr(float(abs(value))).partition("e")
    whole, _, frac = mantissa.partition(".")
    digits = (whole + frac).lstrip("0")
    stripped = digits.rstrip("0")
    # value == int(stripped) * 10 ** (n - k), the spec's n and k
    k = len(stripped)
    n = len(digits) + int(exponent or 0) - len(frac)
    if k <= n <= 21:
        return sign + stripped + "0" * (n - k)
    if 0 < n <= 21:
        return f"{sign}{stripped[:n]}.{stripped[n:]}"
    if -6 < n <= 0:
        return f"{sign}0.{'0' * -n}{stripped}"
    head = stripped if k == 1 else f"{stripped[0]}.{stripped[1:]}"
    return f"{sign}{head}e{'+' if n > 1 else '-'}{abs(n - 1)}"


def _compact_value_text(value: Any) -> str:
    if isinstance(value, dict):
        items = (
            f"{compact_json_text(str(key))}:{_compact_value_text(item)}"
            for key, item in value.items()
        )
        return "{" + ",".join(items) + "}"
    if isinstance(value, list):
        return (
            "[" + ",".join(_compact_value_text(item) for item in value) + "]"
        )
    if isinstance(value, float):
        return number_text(value)
    return compact_json_text(value)


def value_text(value: Any) -> str:
    """Spell a payload value as text, as compact JSON in both languages.

    A string is itself; anything else renders as compact JSON, so a
    boolean spells ``true`` rather than Python's ``True``, a number lays
    out as ``number_text`` says (an integral float as the integer
    TypeScript never told it apart from), and an object or array spells
    as one JSON literal rather than a ``repr``, its numbers included.
    Path labels and group values are built from this, so one collection
    grows one tree.

    Args:
        value (Any): a decoded JSON value.
    """
    if isinstance(value, str):
        return value
    return _compact_value_text(value)


def ecma_numbers(value: Any) -> Any:
    """``value`` with each float as the text ``number_text`` spells, for
    orjson to write numbers as TypeScript's ``JSON.stringify`` does.

    Args:
        value (Any): a decoded JSON value, a row among them.
    """
    if isinstance(value, float):
        return orjson.Fragment(number_text(value).encode())
    if isinstance(value, dict):
        return {key: ecma_numbers(item) for key, item in value.items()}
    if isinstance(value, list):
        return [ecma_numbers(item) for item in value]
    return value


def jsonl_bytes(rows: list[dict[str, Any]]) -> bytes:
    """Render rows as line-delimited JSON, one compact object per line.

    Numbers use the shared ECMAScript spelling, including nested cells.
    An empty row list renders as empty bytes rather than a lone newline,
    so an empty .jsonl leaf sizes and reads as a zero-byte file.

    Args:
        rows (list[dict]): the rows to render, in output order.
    """
    if not rows:
        return b""
    lines = [_compact_value_text(row) for row in rows]
    return ("\n".join(lines) + "\n").encode()


def jsonl_bytes_by_created_at(rows: list[dict[str, Any]]) -> bytes:
    """Render rows as JSONL in ``created_at`` order.

    A comment feed arrives in whatever order the API paginated it, and a
    file that reads the same twice needs a stable order. ``created_at`` is
    the one field every comment normalizer emits, and a row missing it
    sorts first rather than raising.

    Args:
        rows (list[dict[str, Any]]): normalized comment rows.

    Returns:
        bytes: newline-delimited JSON, oldest first.
    """
    ordered = sorted(rows, key=lambda row: row.get("created_at") or "")
    return jsonl_bytes(ordered)
