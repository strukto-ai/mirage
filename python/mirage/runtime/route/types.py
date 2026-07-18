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
from dataclasses import dataclass, field, replace
from typing import Any

from mirage.runtime.base import Runtime, ScriptSource


@dataclass(frozen=True, slots=True)
class CommandFacts:
    """Parse facts for one command of the line being routed.

    Args:
        command (str): the command name (first word).
        words (tuple[str, ...]): every word of the command, name first.
        builtin (bool): whether the command has a builtin spec.
        paths (tuple[str, ...]): absolute-path operands.
    """

    command: str
    words: tuple[str, ...]
    builtin: bool
    paths: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class RouteContext:
    """Facts about the line being routed, parse-before-route.

    For ``cat /data/logs.txt | python3 process.py`` typed in ``/data``,
    monty's script (monty captures ``python3``) is consulted with::

        ctx.line      == "cat /data/logs.txt | python3 process.py"
        ctx.commands  == (
            CommandFacts(command="cat",
                         words=("cat", "/data/logs.txt"),
                         builtin=True,
                         paths=("/data/logs.txt",)),
            CommandFacts(command="python3",
                         words=("python3", "process.py"),
                         builtin=True,
                         paths=()),
        )
        ctx.command   == "python3"  # monty's first captured stage
        ctx.builtin   == True
        ctx.cwd       == "/data"

    The global route script sees the same context with
    ``ctx.command == "cat"``, the line's first stage. A monty-source
    script gets this as the ``ctx`` dict (see to_dict), with
    ``ctx["runtime"]`` naming the runtime being asked.

    Args:
        line (str): the raw command line.
        commands (tuple[CommandFacts, ...]): parsed commands, empty on
            a syntax error.
        command (str): the stage addressed to the consulted party: an
            entry script sees its runtime's first captured stage (see
            for_runtime), the global route sees the line's first
            command. "" when unparsable.
        builtin (bool): whether ``command`` has a builtin spec.
        cwd (str): session working directory.
        env (dict[str, str]): session environment.
        session_id (str): session hosting the line.
        agent_id (str): agent executing the line.
        mounts (tuple[str, ...]): workspace mount prefixes.
    """

    line: str
    commands: tuple[CommandFacts, ...]
    command: str
    builtin: bool
    cwd: str
    env: dict[str, str]
    session_id: str
    agent_id: str
    mounts: tuple[str, ...]

    def for_runtime(self, runtime: Runtime) -> "RouteContext":
        """The context as one runtime's script sees it.

        ``command``/``builtin`` become the first stage the runtime
        captures, so `ctx.command == 'python3'` means what it reads as
        even on `cat x | python3`. A runtime with no captured stage on
        the line (including the catch-all vfs) keeps the line's first
        stage.

        Args:
            runtime (Runtime): the runtime being consulted.
        """
        for fact in self.commands:
            if fact.command in runtime.captures:
                return replace(self,
                               command=fact.command,
                               builtin=fact.builtin)
        return self

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
                "builtin": c.builtin,
                "paths": list(c.paths),
            } for c in self.commands],
            "command":
            self.command,
            "builtin":
            self.builtin,
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


# A per-runtime willingness script, answering "do I want this line?".
# In code: a callable (sync or async) on the RouteContext returning a
# truthy verdict. From config: a .py file reference, loaded as
# ScriptSource (its last expression is the verdict). Mirrors the TS
# RouteScript.
#
#     def wants(ctx: RouteContext) -> bool:
#         return ctx.builtin and "/secret" not in ctx.line
#
#     VfsRuntime(script=wants)
#
#     # workspace yaml: guard.py next to the config file
#     runtimes:
#       - name: vfs
#         script: guard.py
RouteScript = Callable[[RouteContext], bool | Awaitable[bool]] | ScriptSource

# The global route, answering "who takes this line?". In code: a
# callable (sync or async) on the RouteContext returning a runtime
# name, or None to pass down the ladder. From config: a .py file
# reference, loaded as ScriptSource (its last expression is that name
# or None). Mirrors the TS RouteFn.
#
#     def route(ctx: RouteContext) -> str | None:
#         return "wasi" if ctx.command == "python3" else None
#
#     Workspace(..., route=route)
#
#     # workspace yaml: route.py next to the config file
#     route: route.py
RouteFn = Callable[[RouteContext],
                   str | None | Awaitable[str | None]] | ScriptSource


@dataclass(frozen=True, slots=True)
class RoutingDecision:
    """The one-line placement decision the dispatcher consults.

    Both fields hold runtimes: the decision IS "which runtime runs
    which command". The vfs runtime is a legal value in either; a
    command placed on it is served by the workspace executor itself.

    Args:
        bindings (dict[str, Runtime | None]): every command some entry
            captures, resolved for this line: the runtime it runs on,
            or None when its capturers all refused (admission failure,
            exit 126, never a silent fallback to the workspace).
        fallback (Runtime | None): where commands no entry captures
            run: the catch-all vfs runtime, or None when the vfs
            runtime refused the line or declares captures; unbound
            commands then exit 126.
    """

    bindings: dict[str, Runtime | None] = field(default_factory=dict)
    fallback: Runtime | None = None
