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

from mirage.environments.openenv import MirageAction, MirageObservation
from mirage.types import JsonValue
from mirage.workspace.tools.tool_descriptions import (
    SHELL_DESCRIPTION,
    SHELL_INPUT,
)

SHELL_TOOL_SCHEMA: dict[str, JsonValue] = {
    "type": "function",
    "function": {
        "name": "shell",
        "description": SHELL_DESCRIPTION,
        "parameters": SHELL_INPUT,
    },
}


def shell_action(command: str) -> MirageAction:
    """Build a ``MirageAction`` running ``command`` in the episode shell.

    Args:
        command (str): POSIX shell line to execute.

    Returns:
        MirageAction: Validated OpenEnv shell action.
    """
    return MirageAction(tool="shell", arguments={"command": command})


def format_observation(obs: MirageObservation) -> str:
    """Format a ``MirageObservation`` as plain tool-result text for an LLM.

    Args:
        obs (MirageObservation): Step result from ``MirageOpenEnv``.

    Returns:
        str: Combined stdout, stderr, refusal note, and exit status.
    """
    parts: list[str] = []
    if obs.stdout:
        parts.append(obs.stdout.rstrip("\n"))
    if obs.stderr:
        parts.append(obs.stderr.rstrip("\n"))
    if obs.refusal is not None:
        parts.append(f"[refused ({obs.refusal.kind}): {obs.refusal.reason}]")
    if obs.exit_code != 0 or not parts:
        parts.append(f"[exit_code={obs.exit_code}]")
    return "\n".join(parts)
