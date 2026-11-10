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
from collections.abc import Mapping

LEADING_COUNT = re.compile(r"\s*([0-9]+)\s*(?:,|\Z)")


def _thread_count(value: str | None) -> int | None:
    """The first positive count an OpenMP variable holds, None without one.

    Args:
        value (str | None): the variable's value.
    """
    found = LEADING_COUNT.match(value) if value is not None else None
    count = int(found.group(1)) if found is not None else 0
    return count if count > 0 else None


def thread_limit(env: Mapping[str, str], cpus: int) -> int:
    """The processors a program may use, under the OpenMP limits.

    Args:
        env (Mapping[str, str]): the session's environment.
        cpus (int): the processors it has.
    """
    count = _thread_count(env.get("OMP_NUM_THREADS")) or cpus
    limit = _thread_count(env.get("OMP_THREAD_LIMIT"))
    return min(count, limit) if limit is not None else count
