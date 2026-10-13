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

from mirage.runtime.config import HomeConfig, memory_limit


@dataclass(frozen=True, slots=True)
class WasiConfig(HomeConfig):
    """Config for the wasi runtime.

    Args:
        home (str | None): the CPython WASI build directory. None falls
            back to MIRAGE_WASI_HOME.
        max_memory (str | int | None): the linear memory one run may grow to,
            spelled as sandlock spells its own (``128M``, ``1G``); a run
            that needs more raises ``MemoryError``, and one below the
            interpreter's own start (about 40M) cannot start. None for
            no cap.
    """

    max_memory: str | int | None = None

    def __post_init__(self) -> None:
        memory_limit(self.max_memory)
