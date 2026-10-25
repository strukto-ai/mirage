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


from collections.abc import Sequence

from mirage.rs.policy import from_units, policy_pattern, units


def split_pattern(pattern: str) -> tuple[str, ...]:
    return tuple(
        from_units(value)
        for value in policy_pattern(units(pattern), (), False)[0]
    )


def pattern_matches(pattern: str, tokens: Sequence[str]) -> bool:
    return policy_pattern(
        units(pattern), tuple(units(v) for v in tokens), False
    )[1]


def pattern_reaches(pattern: str, path: Sequence[str]) -> bool:
    return policy_pattern(
        units(pattern), tuple(units(v) for v in path), False
    )[2]
