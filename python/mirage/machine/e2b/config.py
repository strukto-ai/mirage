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
from dataclasses import dataclass

from mirage.machine.config import (
    MachineConfig,
    check_on_pause,
    require_id,
)
from mirage.machine.e2b.constants import ON_PAUSE
from mirage.machine.types import PauseAction


@dataclass(frozen=True, slots=True, kw_only=True)
class E2BConfig(MachineConfig):
    """How to reach an E2B sandbox: yours, by its id, or one Mirage
    starts from a template.

    Args:
        sandbox_id (str | None): id of a sandbox you created (`e2b sandbox
            spawn` or the SDK), with workspace files visible at matching
            paths when commands need them. None: Mirage starts one from
            ``template`` at the first run that needs it.
        template (str | None): the template Mirage starts a sandbox from
            when no ``sandbox_id`` is given; None is E2B's ``base``.
        idle_timeout (float | None): seconds a sandbox Mirage started
            stays up once Mirage's work there ends, before E2B pauses
            it; the next work resumes it. None is
            ``IDLE_TIMEOUT_SECONDS``. A sandbox you brought keeps its own
            timeout.
        api_key (str | None): E2B credential; None reads E2B_API_KEY.
        on_pause (PauseAction | None): ``pause`` pauses the sandbox when
            the workspace pauses; None leaves it as it is.
    """

    sandbox_id: str | None = None
    template: str | None = None
    idle_timeout: float | None = None
    api_key: str | None = None
    on_pause: PauseAction | None = None

    def __post_init__(self) -> None:
        if self.sandbox_id is not None:
            require_id("e2b", "sandbox_id", self.sandbox_id)
        if self.template is not None:
            require_id("e2b", "template", self.template)
        idle = self.idle_timeout
        if idle is not None and (
            isinstance(idle, bool)
            or not isinstance(idle, int | float)
            or not math.isfinite(idle)
            or idle <= 0
        ):
            raise ValueError(
                "e2b: idle_timeout must be a number of seconds above 0, "
                f"got {idle!r}"
            )
        check_on_pause("e2b", self.on_pause, ON_PAUSE)
