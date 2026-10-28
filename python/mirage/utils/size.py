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
import re
from decimal import Decimal

_SIZE = re.compile(r"\s*([0-9]+)(?:([KMG])B?)?\s*", re.IGNORECASE | re.ASCII)
_UNITS = {None: 1, "K": 1 << 10, "M": 1 << 20, "G": 1 << 30}


def parse_limit(limit: str | int | float, field: str) -> int:
    """A size in bytes: an int, digits, or digits with a binary suffix,
    ``KB``/``MB``/``GB`` or sandlock's ``K``/``M``/``G``, in any case.

    The grammar is TypeScript's ``parseLimit`` exactly: ASCII digits, no
    sign, separator, fraction or inner space, at most 2**53 - 1 bytes. A
    whole-number float is its integer, since JavaScript cannot tell
    ``100.0`` from ``100``.

    Args:
        limit (str | int | float): the size as configured.
        field (str): the setting's name, which a refusal starts with.

    Raises:
        ValueError: the value is not a size.
    """
    size = None
    if isinstance(limit, int) and not isinstance(limit, bool):
        size = limit
    elif isinstance(limit, float) and limit.is_integer():
        size = int(limit)
    elif isinstance(limit, str) and (match := _SIZE.fullmatch(limit)):
        digits = match.group(1).lstrip("0")
        if len(digits) <= 16:
            unit = match.group(2)
            size = int(digits or "0") * _UNITS[unit and unit.upper()]
    if size is None or not 0 <= size < 2**53:
        shown = json.dumps(
            limit, ensure_ascii=False, separators=(",", ":"), default=str
        )
        if isinstance(limit, float) and math.isfinite(limit):
            exact = Decimal(repr(limit))
            if 1e-6 <= abs(limit) < 1e21:
                whole = exact == exact.to_integral_value()
                shown = str(int(exact)) if whole else format(exact, "f")
            else:
                shown = re.sub(r"e([+-])0*(?=\d)", r"e\1", repr(limit))
        raise ValueError(f"{field} must be a size like 100MB, got {shown}")
    return size
