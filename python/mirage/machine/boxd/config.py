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
class BoxdConfig(MachineConfig):
    """How to reach the user's boxd machine.

    Args:
        machine_id (str): id of a machine you created (`boxd machine
            new`, the console or the SDK).
        api_key (str | None): boxd API key; None reads BOXD_API_KEY.
        region (str | None): the machine's region (``fra``, ``nyc``);
            None reads BOXD_REGION, then the account's default.
    """

    machine_id: str
    api_key: str | None = None
    region: str | None = None

    def __post_init__(self) -> None:
        require_id("boxd", "machine_id", self.machine_id)
