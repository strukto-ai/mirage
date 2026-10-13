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


def parse_limit(limit: str | int) -> int:
    """A size in bytes: an int, digits, or digits with a binary suffix,
    ``KB``/``MB``/``GB`` or sandlock's ``K``/``M``/``G``.

    Args:
        limit (str | int): the size as configured.

    Raises:
        ValueError: the text is not a size.
    """
    if isinstance(limit, int):
        return limit
    s = limit.strip().upper()
    for suffix, mult in [
        ("GB", 1 << 30),
        ("MB", 1 << 20),
        ("KB", 1 << 10),
        ("G", 1 << 30),
        ("M", 1 << 20),
        ("K", 1 << 10),
    ]:
        if s.endswith(suffix):
            return int(s[: -len(suffix)]) * mult
    return int(s)


def glob_escape(literal: str) -> str:
    """Escape a literal for use inside a redis MATCH pattern.

    Cache keys are mount paths, and a path may legitimately contain the
    glob metacharacters redis SCAN interprets, so a prefix like
    ``/data[1]/`` would otherwise match nothing (or the wrong keys).

    Args:
        literal (str): Text to match verbatim.
    """
    out: list[str] = []
    for ch in literal:
        if ch in "*?[]\\":
            out.append("\\")
        out.append(ch)
    return "".join(out)
