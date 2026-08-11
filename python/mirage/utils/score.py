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
from mirage.types import JsonValue


def score_from_distance(value: JsonValue) -> str:
    """Convert a vector distance into a clamped 0..1 similarity string.

    Args:
        value (JsonValue): Distance reported by the vector store; anything
            non-numeric (including bool) collapses to "0.00".
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return "0.00"
    return f"{max(0.0, 1.0 - float(value)):.2f}"


def format_score(value: JsonValue) -> str | None:
    """Format a provider-supplied similarity score to two decimals.

    Args:
        value (JsonValue): Score reported by the provider; anything
            non-numeric (including bool) yields None.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return f"{value:.2f}"
