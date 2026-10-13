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

from dataclasses import dataclass

from mirage.runtime.config import RuntimeConfig, memory_limit


@dataclass(frozen=True, slots=True)
class MontyConfig(RuntimeConfig):
    """Config for the monty runtime.

    Args:
        max_memory (str | None): the heap one run may use, spelled as
            sandlock spells its own (``10M``, ``1G``); a run that needs
            more raises ``MemoryError``. None for no cap.
    """

    max_memory: str | None = None

    def __post_init__(self) -> None:
        memory_limit(self.max_memory)
