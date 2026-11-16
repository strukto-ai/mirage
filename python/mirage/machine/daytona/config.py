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

from mirage.machine.config import MachineConfig, check_on_pause, require_id
from mirage.machine.daytona.constants import ON_PAUSE
from mirage.machine.types import PauseAction


@dataclass(frozen=True, slots=True, kw_only=True)
class DaytonaConfig(MachineConfig):
    """How to reach the user's live Daytona sandbox.

    Args:
        sandbox_id (str): id of a sandbox you created (dashboard,
            `daytona sandbox create`, or the SDK). Boot it from an
            image or snapshot with fuse3 and mirage installed.
        api_key (str | None): Daytona credential; None reads
            DAYTONA_API_KEY.
        on_pause (PauseAction | None): ``pause`` pauses the sandbox when
            the workspace pauses; None leaves it as it is.
    """

    sandbox_id: str
    api_key: str | None = None
    on_pause: PauseAction | None = None

    def __post_init__(self) -> None:
        require_id("daytona", "sandbox_id", self.sandbox_id)
        check_on_pause("daytona", self.on_pause, ON_PAUSE)
