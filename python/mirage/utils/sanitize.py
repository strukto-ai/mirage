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


from mirage.rs.stream import open_stream
from mirage.types import JsonValue

NAME_MAX_BYTES = 255
SAFE_SLASH = "∕"
ESCAPE_LEAD = "⁄"


def _sanitize(text: str, config: dict[str, JsonValue]) -> str:
    """Apply the shared filename rules.

    Args:
        text (str): the API-supplied label.
        config (dict[str, JsonValue]): the operation and its budgets.
    """
    stream = open_stream("sanitize", config)
    stream.feed(text.encode())
    return stream.finish().decode()


def is_blank(text: str) -> bool:
    """Test Unicode White_Space (text: str)."""
    return _sanitize(text, {"op": "blank"}) == "1"


def byte_length(text: str) -> int:
    """Measure a filename in UTF-8 bytes (text: str)."""
    return len(text.encode())


def truncate_bytes(text: str, budget: int) -> str:
    """Keep a UTF-8 prefix without splitting a character.

    Args:
        text (str): the label to trim.
        budget (int): the maximum byte length.
    """
    return _sanitize(text, {"op": "truncate", "budget": budget})


def sanitize_name(name: str) -> str:
    """Render a shell-safe, nonempty name (name: str)."""
    return _sanitize(name, {"op": "name"})


def path_safe_name(name: str) -> str:
    """Escape separators and a leading dot, preserving spelling (name: str)."""
    return _sanitize(name, {"op": "path"})


def sanitize_label(
    text: str, *, fallback: str, max_len: int, max_bytes: int = NAME_MAX_BYTES
) -> str:
    """Render a shell-safe label under character and UTF-8 byte budgets.

    Args:
        text (str): the label to render.
        fallback (str): the result for a blank or wholly unsafe label.
        max_len (int): the character budget, including an ellipsis.
        max_bytes (int): the byte budget remaining in the filename.
    """
    return _sanitize(
        text,
        {
            "op": "label",
            "fallback": fallback,
            "max_len": max_len,
            "max_bytes": max_bytes,
        },
    )
