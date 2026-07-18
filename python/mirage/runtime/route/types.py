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
from typing import Any

from mirage.runtime.base import Runtime


@dataclass(frozen=True, slots=True)
class CommandFacts:
    """Parse facts for one command of the line being routed.

    Args:
        command (str): the command name (first word).
        words (tuple[str, ...]): every word of the command, name first.
        known (bool): whether the command has a builtin spec.
        paths (tuple[str, ...]): absolute-path operands.
    """

    command: str
    words: tuple[str, ...]
    known: bool
    paths: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class RouteContext:
    """Facts about the line being routed, parse-before-route.

    Args:
        line (str): the raw command line.
        commands (tuple[CommandFacts, ...]): parsed commands, empty on
            a syntax error.
        command (str): the first command name, "" when unparsable.
        known (bool): whether the first command has a builtin spec.
        cwd (str): session working directory.
        env (dict[str, str]): session environment.
        session_id (str): session hosting the line.
        agent_id (str): agent executing the line.
        mounts (tuple[str, ...]): workspace mount prefixes.
    """

    line: str
    commands: tuple[CommandFacts, ...]
    command: str
    known: bool
    cwd: str
    env: dict[str, str]
    session_id: str
    agent_id: str
    mounts: tuple[str, ...]

    def to_dict(self, runtime: Runtime | None = None) -> dict[str, Any]:
        """The monty-facing ctx payload.

        Args:
            runtime (Runtime | None): the runtime being asked, added as
                ctx["runtime"] for per-runtime scripts.
        """
        payload: dict[str, Any] = {
            "line":
            self.line,
            "commands": [{
                "command": c.command,
                "words": list(c.words),
                "known": c.known,
                "paths": list(c.paths),
            } for c in self.commands],
            "command":
            self.command,
            "known":
            self.known,
            "cwd":
            self.cwd,
            "env":
            dict(self.env),
            "session_id":
            self.session_id,
            "agent_id":
            self.agent_id,
            "mounts":
            list(self.mounts),
        }
        if runtime is not None:
            payload["runtime"] = {
                "name": runtime.name,
                "captures": list(runtime.captures),
            }
        return payload


# A per-runtime willingness script: a callable on the RouteContext
# returning a truthy verdict, or monty source whose last expression is
# the verdict. Mirrors the TS RouteScript.
RouteScript = Callable[[RouteContext], bool | Awaitable[bool]] | str

# The global route: a callable on the RouteContext returning a runtime
# name (or None to pass), or monty source. Mirrors the TS RouteFn.
RouteFn = Callable[[RouteContext], str | None | Awaitable[str | None]] | str


@dataclass(frozen=True, slots=True)
class RoutingDecision:
    """The one-line placement decision the dispatcher consults.

    Args:
        bindings (dict[str, Runtime]): command -> runtime for this
            line.
        vfs_allowed (bool): whether unbound commands may run on the
            vfs executor; False turns them into admission failures.
        captured (frozenset[str]): commands captured by some entry;
            an unbound captured command is an admission failure (its
            capturers all refused), never a silent fallback.
    """

    bindings: dict[str, Runtime] = field(default_factory=dict)
    vfs_allowed: bool = True
    captured: frozenset[str] = frozenset()
