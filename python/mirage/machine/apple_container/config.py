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

from mirage.machine.config import MachineConfig, require_id


@dataclass(frozen=True, slots=True, kw_only=True)
class AppleContainerConfig(MachineConfig):
    """How to reach the user's running container.

    Args:
        container (str): id of a running container. You start it
            yourself; give each agent a container of its own as a
            machine of its own.
    """

    container: str

    def __post_init__(self) -> None:
        require_id("apple_container", "container", self.container)
