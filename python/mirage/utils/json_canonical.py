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
from typing import Any


def canonicalize_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: canonicalize_value(v) for k, v in value.items()}
    if isinstance(value, list):
        return [canonicalize_value(v) for v in value]
    if (isinstance(value, float) and not isinstance(value, bool)
            and math.isfinite(value) and value.is_integer()):
        return int(value)
    return value


def canonicalize_row(row: dict[str, Any]) -> dict[str, Any]:
    return {k: canonicalize_value(v) for k, v in row.items()}
