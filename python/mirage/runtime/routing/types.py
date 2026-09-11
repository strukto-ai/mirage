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

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field, replace
from typing import Any

from mirage.runtime.base import Runtime
from mirage.runtime.types import ScriptSource


@dataclass(frozen=True, slots=True)
class ParsedCommand:
    """One command of the line being routed, distilled from the parse.

    Args:
        command (str): the command name (first word).
        words (tuple[str, ...]): every word of the command, name first.
        builtin (bool): whether the command has a builtin spec.
        paths (tuple[str, ...]): absolute-path operands.
        cli (str | None): the installed CLI whose head word ``command``
            is, None otherwise. Lets a policy steer an installed name
            between the virtual CLI and a runtime capturing the same
            word.
    """

    command: str
    words: tuple[str, ...]
    builtin: bool
    paths: tuple[str, ...]
    cli: str | None = None


@dataclass(frozen=True, slots=True)
class RouteContext:
    """What a policy may consult about the line, parse-before-policy.

    For ``cat /data/logs.txt | python3 process.py`` typed in ``/data``,
    monty's script (monty captures ``python3``) is consulted with::

        ctx.line      == "cat /data/logs.txt | python3 process.py"
        ctx.commands  == (
            ParsedCommand(command="cat",
                          words=("cat", "/data/logs.txt"),
                          builtin=True,
                          paths=("/data/logs.txt",)),
            ParsedCommand(command="python3",
                          words=("python3", "process.py"),
                          builtin=True,
                          paths=()),
        )
        ctx.command   == "python3"  # monty's first captured stage
        ctx.builtin   == True
        ctx.cwd       == "/data"

    The global policy script sees the same context with
    ``ctx.command == "cat"``, the line's first stage. A monty-source
    script gets this as the ``ctx`` dict (see to_dict), with
    ``ctx["runtime"]`` naming the runtime being asked.

    Args:
        line (str): the raw command line.
        commands (tuple[ParsedCommand, ...]): parsed commands, empty on
            a syntax error.
        command (str): the stage addressed to the consulted party: an
            entry script sees its runtime's first captured stage (see
            for_runtime), the global policy sees the line's first
            command. "" when unparsable.
        builtin (bool): whether ``command`` has a builtin spec.
        cwd (str): session working directory.
        env (dict[str, str]): session environment.
        session_id (str): session hosting the line.
        agent_id (str): agent executing the line.
        mounts (tuple[str, ...]): workspace mount prefixes.
    """

    line: str
    commands: tuple[ParsedCommand, ...]
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
        for parsed in self.commands:
            if parsed.command in runtime.captures:
                return replace(self,
                               command=parsed.command,
                               builtin=parsed.builtin)
        return self

    def to_dict(self, runtime: Runtime | None = None) -> dict[str, Any]:
        """The ctx payload as any evaluator's script sees it.

        This is the policy context WIRE SCHEMA, a public contract:
        JSON-shaped (strings, bools, lists, dicts), snake_case keys,
        identical in both languages, so a script in any evaluator's
        language (and any transport, in-process or remote) receives
        the same structure. Keys: line, commands (command/words/
        builtin/paths/cli per stage), command, builtin, cwd, env,
        session_id, agent_id, mounts, plus runtime (name/captures)
        for per-runtime scripts. from_dict is the inverse, so a
        payload can be stored as JSON and replayed.

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
                "cli": c.cli,
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

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "RouteContext":
        """Rebuild a context from its wire-schema payload.

        The inverse of to_dict for the context's own fields (the
        payload's ``runtime`` block is per-consultation decoration and
        is ignored), so a stored JSON payload replays through scripts
        and routes in tests or debugging.

        Args:
            payload (dict[str, Any]): a to_dict-shaped payload.
        """
        return cls(
            line=str(payload["line"]),
            commands=tuple(
                ParsedCommand(
                    command=str(c["command"]),
                    words=tuple(c["words"]),
                    builtin=bool(c["builtin"]),
                    paths=tuple(c["paths"]),
                    cli=(str(c["cli"]) if c.get("cli") is not None else None))
                for c in payload["commands"]),
            command=str(payload["command"]),
            builtin=bool(payload["builtin"]),
            cwd=str(payload["cwd"]),
            env=dict(payload["env"]),
            session_id=str(payload["session_id"]),
            agent_id=str(payload["agent_id"]),
            mounts=tuple(payload["mounts"]),
        )


# A per-runtime willingness script, answering "do I want this line?".
# In code: a callable (sync or async) on the RouteContext returning a
# truthy verdict. From config: a .py file reference, loaded as
# ScriptSource (its last expression is the verdict). Mirrors the TS
# RouteScript.
#
#     def wants(ctx: RouteContext) -> bool:
#         return ctx.builtin and "/secret" not in ctx.line
#
#     VFSRuntime(script=wants)
#
#     # workspace yaml: guard.py next to the config file
#     runtimes:
#       - name: vfs
#         script: guard.py
RouteScript = Callable[[RouteContext], bool | Awaitable[bool]] | ScriptSource


class RouteOutcome:
    """The typed spelling of a policy verdict, one subclass per arm.

    Code policies return an arm instance (or the plain-shape sugar
    below); config scripts return the wire dict, since class instances
    cannot cross the evaluator sandbox. Each arm serializes to one
    wire key, and future powers grow as fields on the arm they ride
    (attachments on RouteResult, kubernetes-admission style).
    """


@dataclass(frozen=True, slots=True)
class RouteResult(RouteOutcome):
    """The affirmative arm: this runtime serves the line.

    Args:
        runtime (str): name of the entry that serves every command it
            captures on this line. Wire form: {"runtime": name}.
    """

    runtime: str


@dataclass(frozen=True, slots=True)
class DenyResult(RouteOutcome):
    """The negative arm: refuse the line before anything runs.

    The line exits 126 with ``<command>: Permission denied`` on
    stderr and the reason on the result's ``refusal`` record. Wire
    form: {"deny": reason}.

    Args:
        reason (str): why the line was denied.
    """

    reason: str


# What the global policy may answer: a RouteOutcome arm, a runtime
# name, None to pass, or the verdict dict (the wire spelling of the
# arms, the only form a config script can return). Dict keys are
# mutually exclusive: {"runtime": name} places the line, {"deny":
# reason} refuses it. New powers grow as arm fields and dict keys,
# never as new return types. Mirrors the TS RouteVerdict.
RouteVerdict = RouteOutcome | str | Mapping[str, Any] | None

# The global policy, answering "who takes this line?". In code: a
# callable (sync or async) on the RouteContext returning a
# RouteVerdict. From config: a .py file reference, loaded as
# ScriptSource (its last expression is the verdict). Mirrors the TS
# RoutePolicy.
#
#     def policy(ctx: RouteContext) -> str | None:
#         return "wasi" if ctx.command == "python3" else None
#
#     Workspace(..., route_policy=policy)
#
#     # workspace yaml: policy.py next to the config file
#     route_policy: policy.py
RoutePolicy = Callable[[RouteContext],
                       RouteVerdict | Awaitable[RouteVerdict]] | ScriptSource


@dataclass(frozen=True, slots=True)
class RouteDecision:
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
