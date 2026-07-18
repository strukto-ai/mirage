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
from typing import Any

from mirage.types import ConsistencyPolicy


@dataclass
class MountArgs:
    """Constructor inputs derived from a state dict.

    Workspace.load uses this to instantiate a fresh Workspace; snapshot
    code never constructs Workspace itself.
    """
    mount_args: dict[str, Any]
    consistency: ConsistencyPolicy
    default_session_id: str
    default_agent_id: str | None
