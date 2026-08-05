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

from dataclasses import dataclass, replace
from typing import Any, ClassVar, Protocol

from mirage.types import Limit, PathSpec, Producer


class RuntimeIdentity(Protocol):
    """What ExecuteContext needs to know about a runtime.

    Runtime satisfies this structurally; the narrow protocol keeps this
    package a leaf (no runtime imports).
    """

    @property
    def name(self) -> str:
        ...

    @property
    def captures(self) -> tuple[str, ...]:
        ...


class MountRootQuery(Protocol):
    """The one registry question policy hooks may ask.

    MountRegistry satisfies this structurally; the narrow protocol keeps
    this package a leaf (no workspace imports), so the registry can host
    a Policies instance without a cycle.
    """

    def is_mount_root(self, path: str) -> bool:
        ...


@dataclass(frozen=True, slots=True)
class Deny:
    """Refuse the command with a message on stderr.

    Args:
        message (str): full stderr text, newline-terminated.
        exit_code (int): the command's exit code; 1 by default, the
            GNU spelling of an operand-level refusal.
    """

    kind: ClassVar[str] = "deny"

    message: str
    exit_code: int = 1


@dataclass(frozen=True, slots=True)
class Route:
    """Place the line on a named runtime, the affirmative routing arm.

    Only legal from ``pre_execute``. The first Route wins (placement is
    an affirmative choice, never a refusal); an unknown runtime name is
    a PolicyError at the router, mirroring the ``runtime=`` argument.

    Args:
        runtime (str): name of the entry that serves every command it
            captures on this line.
    """

    kind: ClassVar[str] = "route"

    runtime: str


# The closed vocabulary of policy answers: a hook returns an Action to
# state an opinion or None to stay silent. Deny refuses (first opinion
# wins); Limit bounds (every opinion merges to the tightest, Limit.aggr);
# Route places the line on a runtime (first Route wins). Each hook
# accepts a fixed set of kinds (VALIDITY), enforced loud.
Action = Deny | Limit | Route


@dataclass(frozen=True, slots=True)
class GuardSpec:
    """A declarative guard: refuse matching commands on matching paths.

    The YAML ``guards:`` block and ``Workspace(guards=[...])`` accept
    this shape; ``Policies.add`` compiles it to a SpecPolicy. Patterns
    match the absolute virtual path with ``*`` (any run, including
    ``/``) and ``?`` (any one character).

    Args:
        reason (str): why the command is refused, shown on stderr.
        commands (tuple[str, ...]): command names the guard applies to;
            empty means every command.
        paths (tuple[str, ...]): path patterns; empty refuses the
            command regardless of its operands.
    """

    reason: str
    commands: tuple[str, ...] = ()
    paths: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class CommandContext:
    """Facts about one classified command, as pre_command hooks see it.

    Args:
        command (str): the command name.
        paths (tuple[PathSpec, ...]): positional path operands.
        argv (tuple[str, ...]): raw argv after the command name; the
            hook fires before flag parsing, so shorthand flags are raw
            tokens.
        cwd (str): session working directory.
        registry (MountRootQuery): mount-root oracle for POSIX rules.
    """

    command: str
    paths: tuple[PathSpec, ...]
    argv: tuple[str, ...]
    cwd: str
    registry: MountRootQuery


@dataclass(frozen=True, slots=True)
class OpsContext:
    """Facts about one VFS op, as pre_ops hooks see it.

    Fires at the op doors (the ``ws.ops`` facade, which also serves
    FUSE, and the shell's internal dispatcher), before any backend or
    cache I/O, so it holds however the mount is reached.

    Args:
        op (str): operation name (read, write, unlink, readdir, ...).
        path (PathSpec): the resolved virtual path.
        write (bool): whether the op mutates the mount.
        prefix (str): the owning mount's prefix.
    """

    op: str
    path: PathSpec
    write: bool
    prefix: str


@dataclass(frozen=True, slots=True)
class OpsResultContext:
    """One completed VFS op, as post_ops hooks see it.

    Args:
        op (str): operation name.
        path (PathSpec): the resolved virtual path.
        write (bool): whether the op mutated the mount.
        prefix (str): the owning mount's prefix.
        result (Any): the op's raw result (bytes, FileStat, listing,
            ...); a Deny here suppresses it.
    """

    op: str
    path: PathSpec
    write: bool
    prefix: str
    result: Any


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
class ExecuteContext:
    """One typed line about to execute, as pre_execute hooks see it.

    Fires parse-before-dispatch, so a Deny refuses the line before
    anything runs and a Route places it on a runtime. For
    ``cat /data/logs.txt | python3 process.py`` typed in ``/data``,
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

    A pre_execute hook sees the same context with ``ctx.command`` as the
    line's first stage. A config script gets this as the ``ctx`` dict
    (see to_dict), with ``ctx["runtime"]`` naming the runtime being
    asked.

    Args:
        line (str): the raw command line.
        commands (tuple[ParsedCommand, ...]): parsed commands, empty on
            a syntax error.
        command (str): the stage addressed to the consulted party: an
            entry script sees its runtime's first captured stage (see
            for_runtime), a hook sees the line's first command. ""
            when unparsable.
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

    def for_runtime(self, runtime: RuntimeIdentity) -> "ExecuteContext":
        """The context as one runtime's script sees it.

        ``command``/``builtin`` become the first stage the runtime
        captures, so ``ctx.command == 'python3'`` means what it reads as
        even on ``cat x | python3``. A runtime with no captured stage on
        the line (including the catch-all vfs) keeps the line's first
        stage.

        Args:
            runtime (RuntimeIdentity): the runtime being consulted.
        """
        for parsed in self.commands:
            if parsed.command in runtime.captures:
                return replace(self,
                               command=parsed.command,
                               builtin=parsed.builtin)
        return self

    def to_dict(self,
                runtime: RuntimeIdentity | None = None) -> dict[str, Any]:
        """The ctx payload as any evaluator's script sees it.

        This is the execute context WIRE SCHEMA, a public contract:
        JSON-shaped (strings, bools, lists, dicts), snake_case keys,
        identical in both languages, so a script in any evaluator's
        language (and any transport, in-process or remote) receives
        the same structure. Keys: line, commands (command/words/
        builtin/paths/cli per stage), command, builtin, cwd, env,
        session_id, agent_id, mounts, plus runtime (name/captures)
        for per-runtime scripts. from_dict is the inverse, so a
        payload can be stored as JSON and replayed.

        Args:
            runtime (RuntimeIdentity | None): the runtime being asked,
                added as ctx["runtime"] for per-runtime scripts.
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
    def from_dict(cls, payload: dict[str, Any]) -> "ExecuteContext":
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


@dataclass(frozen=True, slots=True)
class ExecuteResultContext:
    """One finished execute() line, as post_execute hooks see it.

    Fires at the workspace boundary before the line's output stream is
    finalized, so a Limit returned here bounds what the caller sees.

    Args:
        producer (Producer): provenance of the surviving stream (the
            rightmost command, per shell semantics); a Producer with an
            empty command when no dispatch site stamped one.
        exit_code (int): the line's exit code so far.
    """

    producer: Producer
    exit_code: int


VALIDITY: dict[str, frozenset[str]] = {
    "pre_command": frozenset({Deny.kind}),
    "pre_execute": frozenset({Deny.kind, Route.kind}),
    "pre_ops": frozenset({Deny.kind}),
    "post_ops": frozenset({Deny.kind, Limit.kind}),
    "post_execute": frozenset({Limit.kind}),
}
