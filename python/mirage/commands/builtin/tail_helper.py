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

import re
from dataclasses import dataclass

_NUMBER_RE = re.compile(r"^[+-]?[0-9]+$")


def number_flag_error(cmd: str, n_raw: str | None,
                      c_raw: str | None) -> str | None:
    if n_raw is not None and not _NUMBER_RE.match(n_raw):
        return f"{cmd}: invalid number of lines: '{n_raw}'\n"
    if c_raw is not None and not _NUMBER_RE.match(c_raw):
        return f"{cmd}: invalid number of bytes: '{c_raw}'\n"
    return None


def _parse_n(n: str | None) -> tuple[int, bool]:
    if n is None:
        return 10, False
    if n.startswith("+"):
        return int(n[1:]), True
    return int(n), False


@dataclass(frozen=True, slots=True)
class TailCounts:
    lines: int | None = None
    from_line: int | None = None
    byte_count: int | None = None
    from_byte: int | None = None


def parse_counts(n: str | None, c: str | None) -> TailCounts:
    """Split tail's ``-n``/``-c`` values by which end they count from.

    GNU gives both flags the same sign grammar: a leading ``+`` counts
    forward from the start of the input, 1-indexed, so ``+0`` and ``+1``
    both mean the whole thing; any other spelling counts back from the
    end. Every caller used to apply that grammar to ``-n`` and take the
    absolute value of ``-c``, which silently turned ``tail -c +3`` into
    the last three bytes -- so the split lives here, once, beside the
    parser it is built from.

    Args:
        n (str | None): the raw ``-n`` value, or None when unset.
        c (str | None): the raw ``-c`` value, or None when unset.
    """
    lines: int | None = None
    from_line: int | None = None
    if n is not None:
        count, plus_mode = _parse_n(n)
        if plus_mode:
            from_line = count
        else:
            lines = count
    byte_count: int | None = None
    from_byte: int | None = None
    if c is not None:
        count, plus_mode = _parse_n(c)
        if plus_mode:
            from_byte = count
        else:
            byte_count = count
    return TailCounts(lines, from_line, byte_count, from_byte)
