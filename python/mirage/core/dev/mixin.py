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

from abc import ABC, abstractmethod

from mirage.core.dev.pipe import DevicePipe


class PipeFiles(ABC):
    """Opt-in capability for a byte table with virtual pipe endpoints."""

    @abstractmethod
    def pipe_of(self, key: str) -> DevicePipe | None: ...

    @abstractmethod
    def holds_pipe(self, key: str) -> bool:
        """Whether a pipe endpoint sits at ``key`` or anywhere below it.

        Args:
            key (str): the store key.
        """
