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

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Literal, Self, TypeAlias

import jsonschema
from pydantic import BaseModel, ConfigDict, Field, JsonValue, model_validator
from pydantic_core import PydanticCustomError

try:
    from openenv.core.env_server.types import Action, Observation, State
except ImportError as exc:
    raise ImportError(
        "`openenv` not installed. Install with: "
        "pip install 'openenv @ git+https://github.com/openenv/OpenEnv'"
    ) from exc

from mirage.environments.openenv.constants import INPUTS
from mirage.types import PolicyDecisionKind
from mirage.workspace.workspace import Session, Workspace

ToolName: TypeAlias = Literal[
    "shell", "read", "write", "edit", "ls", "grep", "glob"
]


class MirageAction(Action):
    """One call into the episode's session: a shell line or one of
    Mirage's file tools, with the tool's MCP input.

    The arguments are checked against the tool's input schema when the
    action is built, so a malformed action never reaches the workspace.

    Args:
        tool (ToolName): ``shell``, ``read``, ``write``, ``edit``,
            ``ls``, ``grep`` or ``glob``.
        arguments (dict[str, JsonValue]): The tool's input, as its MCP
            schema reads it: ``{"command": "ls /data"}`` for ``shell``.
    """

    tool: ToolName = "shell"
    arguments: dict[str, JsonValue] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _arguments_fit_the_tool(self) -> Self:
        try:
            jsonschema.validate(self.arguments, INPUTS[self.tool])
        except jsonschema.ValidationError as exc:
            raise PydanticCustomError(
                "tool_arguments",
                "{tool}: {message}",
                {"tool": self.tool, "message": exc.message},
            ) from exc
        return self


class Refusal(BaseModel):
    """Why Mirage's policy refused a shell line, beside its stderr.

    Args:
        kind (PolicyDecisionKind): ``deny`` for a policy's refusal,
            ``pending`` for an ask nobody answered, ``failed`` for a
            policy that raised.
        reason (str): The policy's own words.
        policy (str): The class name of the policy that spoke; empty for
            an ask.
        ask_id (str | None): The approval id of a ``pending`` ask.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    kind: PolicyDecisionKind
    reason: str
    policy: str = ""
    ask_id: str | None = None


class MirageObservation(Observation):
    """What one action left: its output, its status and the session's
    working directory after it.

    A file tool's answer is its stdout, or its stderr with exit code 1
    when it failed. ``refusal`` is set when a policy refused a shell
    line; a file tool's refusal reads in its stderr.

    Args:
        tool (ToolName | None): The tool that ran; None on reset.
        stdout (str): The standard output, decoded as UTF-8.
        stderr (str): The standard error, decoded as UTF-8.
        exit_code (int): The status: 124 for a timeout, 126 for a tool
            the session's profile does not offer.
        refusal (Refusal | None): The policy's refusal of a shell line.
        timed_out (bool): Whether the action ran past its timeout.
        cwd (str): The session's working directory after the action.
    """

    tool: ToolName | None = None
    stdout: str = ""
    stderr: str = ""
    exit_code: int = 0
    refusal: Refusal | None = None
    timed_out: bool = False
    cwd: str = "/"


class MirageState(State):
    """The episode the environment is in.

    Args:
        workspace_id (str | None): The episode workspace's id; None
            before the first reset.
        session_id (str | None): The session the agent acts as.
        cwd (str | None): The session's working directory.
        seed (int | None): The seed the episode was reset with.
    """

    workspace_id: str | None = None
    session_id: str | None = None
    cwd: str | None = None
    seed: int | None = None


@dataclass(frozen=True, slots=True)
class EpisodeSpec:
    """The reset request an episode starts from.

    Args:
        episode_id (str): The episode's id: the one reset was given, or
            a fresh one.
        seed (int | None): The seed reset was given.
        options (dict[str, JsonValue]): Every other reset parameter,
            such as a task split and index.
    """

    episode_id: str
    seed: int | None = None
    options: dict[str, JsonValue] = field(default_factory=dict)


WorkspaceFactory: TypeAlias = Callable[[EpisodeSpec], Awaitable[Workspace]]
"""Builds the workspace an episode runs in, once per reset."""

SetupHook: TypeAlias = Callable[[Session, EpisodeSpec], Awaitable[None]]
"""Prepares an episode's session after reset builds it."""

RewardHook: TypeAlias = Callable[
    [Session, Action, Observation], Awaitable[float | None]
]
"""Scores one step, with the session to inspect what it changed."""

DoneHook: TypeAlias = Callable[[Session, Action, Observation], Awaitable[bool]]
"""Says whether a step ended the episode."""
