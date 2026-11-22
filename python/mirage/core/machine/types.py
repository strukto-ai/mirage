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

from mirage.core.posix.types import PosixEntry


@dataclass(frozen=True, slots=True)
class Holder:
    """One machine holding a name, and what it reports for it.

    Args:
        machine (str): the machine's name under ``machines:``.
        entry (PosixEntry | None): the name's entry on that machine; None
            on a mount that shows one machine, which is not asked.
    """

    machine: str
    entry: PosixEntry | None = None

    @property
    def folder(self) -> bool:
        """Whether the machine holds a directory at the name; False when
        it was not asked."""
        return self.entry is not None and self.entry.kind == "d"

    @property
    def written(self) -> int:
        """When the machine's copy was last written, in epoch
        milliseconds by its own clock; 0 when it was not asked."""
        return self.entry.mtime_ms if self.entry is not None else 0
