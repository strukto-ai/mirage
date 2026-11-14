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
from mirage.machine.smolvm.constants import ON_PAUSE
from mirage.machine.types import PauseAction


@dataclass(frozen=True, slots=True, kw_only=True)
class SmolvmConfig(MachineConfig):
    """How to reach the user's running microVM.

    Args:
        machine (str): name of a running machine. You start it
            yourself (`smolvm machine create --name mirage` then
            `smolvm machine start --name mirage`); the guest needs
            mirage installed and the workspace served at the host's
            mount prefixes. Named explicitly rather than leaning on
            smolvm's own "default" machine, so a line never lands in
            a VM the config did not choose.
        on_pause (PauseAction | None): ``pause`` pauses the machine when
            the workspace pauses; None leaves it as it is.
    """

    machine: str
    on_pause: PauseAction | None = None

    def __post_init__(self) -> None:
        require_id("smolvm", "machine", self.machine)
        check_on_pause("smolvm", self.on_pause, ON_PAUSE)
