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

from typing import TYPE_CHECKING

from mirage.utils.loader import lazy_exports

if TYPE_CHECKING:
    from mirage.agents.prompt import MIRAGE_SYSTEM_PROMPT, build_system_prompt
    from mirage.environments.openenv.env import MirageOpenEnv
    from mirage.environments.openenv.mcp import (
        MirageMCPTransport,
        MirageServerEnv,
        mirage_server_transport,
    )
    from mirage.environments.openenv.types import (
        DoneHook,
        EpisodeSpec,
        MirageAction,
        MirageObservation,
        MirageState,
        Refusal,
        RewardHook,
        SetupHook,
        WorkspaceFactory,
    )

_EXPORTS: dict[str, tuple[str, ...]] = {
    "mirage.environments.openenv.env": ("MirageOpenEnv",),
    "mirage.environments.openenv.mcp": (
        "MirageMCPTransport",
        "MirageServerEnv",
        "mirage_server_transport",
    ),
    "mirage.environments.openenv.types": (
        "DoneHook",
        "EpisodeSpec",
        "MirageAction",
        "MirageObservation",
        "MirageState",
        "Refusal",
        "RewardHook",
        "SetupHook",
        "WorkspaceFactory",
    ),
    "mirage.agents.prompt": ("MIRAGE_SYSTEM_PROMPT", "build_system_prompt"),
}

__all__ = [
    "MirageOpenEnv",
    "MirageAction",
    "MirageObservation",
    "MirageState",
    "Refusal",
    "EpisodeSpec",
    "WorkspaceFactory",
    "SetupHook",
    "RewardHook",
    "DoneHook",
    "MirageServerEnv",
    "MirageMCPTransport",
    "mirage_server_transport",
    "MIRAGE_SYSTEM_PROMPT",
    "build_system_prompt",
]

__getattr__ = lazy_exports(__name__, _EXPORTS)
