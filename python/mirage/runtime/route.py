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

import asyncio
import inspect
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

import tree_sitter

from mirage.commands.spec import SPECS
from mirage.runtime.base import Runtime
from mirage.runtime.python.monty import _MirageOS, pydantic_monty
from mirage.runtime.table import VfsEntry, bind_commands, pin_bindings
from mirage.shell.types import NodeType


class RoutingDecisionError(ValueError):
    """A pin, route, or script could not decide the line.

    Raised for caller-fixable routing mistakes (unknown pin name, a
    script that does not parse, a missing monty extra) so execute()
    propagates them loud instead of folding them into the line's
    IOResult like a command failure.
    """


_WORD_TYPES = (NodeType.COMMAND_NAME, NodeType.WORD, NodeType.STRING,
               NodeType.RAW_STRING, NodeType.NUMBER, NodeType.CONCATENATION)


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
class LineRouting:
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


def command_facts(ast: tree_sitter.Node) -> tuple[CommandFacts, ...]:
    """Extract per-command parse facts from a parsed line.

    Args:
        ast (tree_sitter.Node): the parsed tree-sitter root node.
    """
    facts: list[CommandFacts] = []
    stack = [ast]
    while stack:
        node = stack.pop()
        if node.type == "command":
            words = tuple(
                child.text.decode() for child in node.children
                if child.type in _WORD_TYPES and child.text is not None)
            if words:
                facts.append(
                    CommandFacts(
                        command=words[0],
                        words=words,
                        known=words[0] in SPECS,
                        paths=tuple(w for w in words[1:] if w.startswith("/")),
                    ))
        stack.extend(reversed(node.children))
    return tuple(facts)


async def _eval_monty(source: str, ctx_payload: dict[str, Any],
                      dispatch: Callable[..., Any] | None) -> Any:
    """Evaluate a monty route script; its last expression is the verdict.

    The script sees the ctx payload as the `ctx` global and may open
    workspace files through the same bridge agent code uses.

    Args:
        source (str): monty source.
        ctx_payload (dict[str, Any]): the RouteContext payload.
        dispatch (Callable | None): workspace dispatch for file reads.

    Raises:
        ImportError: the monty extra is not installed.
        ValueError: the script does not parse or raises.
    """
    if pydantic_monty is None:
        raise ImportError(
            "route scripts run on monty; install with: pip install "
            "mirage-ai[monty], or use a Python callable instead")
    loop = asyncio.get_running_loop()
    bridge = _MirageOS(loop, dispatch, {})
    try:
        program = pydantic_monty.Monty(source, inputs=["ctx"])
    except pydantic_monty.MontySyntaxError as exc:
        raise ValueError("route script syntax error: " +
                         exc.display(format="traceback"))
    try:
        return await program.run_async(inputs={"ctx": ctx_payload}, os=bridge)
    except pydantic_monty.MontyRuntimeError as exc:
        raise ValueError("route script failed: " +
                         exc.display(format="traceback"))


async def evaluate_script(script: RouteScript, ctx: RouteContext,
                          runtime: Runtime,
                          dispatch: Callable[..., Any] | None) -> bool:
    """Ask one runtime's script whether it wants the line.

    Args:
        script (RouteScript): a callable taking the RouteContext, or
            monty source whose last expression is the verdict.
        ctx (RouteContext): facts about the line.
        runtime (Runtime): the runtime being asked (ctx.runtime).
        dispatch (Callable | None): workspace dispatch for file reads.
    """
    if isinstance(script, str):
        verdict = await _eval_monty(script, ctx.to_dict(runtime), dispatch)
    else:
        verdict = script(ctx)
        if inspect.isawaitable(verdict):
            verdict = await verdict
    return bool(verdict)


async def evaluate_route(route: RouteFn, ctx: RouteContext,
                         dispatch: Callable[..., Any] | None) -> str | None:
    """Run the global route, returning a runtime name or None to pass.

    Args:
        route (RouteFn): a callable taking the RouteContext, or monty
            source whose last expression is the name (or None).
        ctx (RouteContext): facts about the line.
        dispatch (Callable | None): workspace dispatch for file reads.

    Raises:
        ValueError: the route returned something other than a runtime
            name or None.
    """
    if isinstance(route, str):
        verdict = await _eval_monty(route, ctx.to_dict(), dispatch)
    else:
        verdict = route(ctx)
        if inspect.isawaitable(verdict):
            verdict = await verdict
    if verdict is None or isinstance(verdict, str):
        return verdict
    raise ValueError(f"route must return a runtime name or None, "
                     f"got {verdict!r}")


async def decide_line(entries: list[Runtime | str], route: RouteFn | None,
                      ctx: RouteContext, static_bindings: dict[str, Runtime],
                      dispatch: Callable[..., Any] | None) -> LineRouting:
    """Resolve the routing ladder for one line: route, then scripts.

    A route verdict overlays the named runtime's captures on the
    static bindings (an affirmative choice, never a refusal). With no
    verdict, per-runtime scripts filter the entry list: an entry with
    no script is always willing, and the willing entries re-bind in
    list order. A captured command whose capturers all refused, or an
    uncaptured command when the vfs entry is absent or unwilling, is
    an admission failure at dispatch.

    Args:
        entries (list[Runtime | str]): the workspace's ordered world.
        route (RouteFn | None): the global route, if configured.
        ctx (RouteContext): facts about the line.
        static_bindings (dict[str, Runtime]): the workspace's static
            command bindings.
        dispatch (Callable | None): workspace dispatch for file reads.
    """
    if route is not None:
        name = await evaluate_route(route, ctx, dispatch)
        if name is not None:
            overlay = pin_bindings(entries, name)
            return LineRouting(bindings={
                **static_bindings,
                **overlay
            },
                               vfs_allowed=True,
                               captured=frozenset())
    willing: list[Runtime | str] = []
    captured: set[str] = set()
    vfs_allowed = False
    for entry in entries:
        if isinstance(entry, str):
            vfs_allowed = True
            willing.append(entry)
            continue
        captured.update(entry.captures)
        wants = (True if entry.script is None else await evaluate_script(
            entry.script, ctx, entry, dispatch))
        if not wants:
            continue
        if isinstance(entry, VfsEntry):
            vfs_allowed = True
        willing.append(entry)
    return LineRouting(bindings=bind_commands(willing),
                       vfs_allowed=vfs_allowed,
                       captured=frozenset(captured))
