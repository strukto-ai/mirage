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
import logging
from dataclasses import dataclass, replace

from mirage.commands.config import Context
from mirage.commands.spec.help import render_help
from mirage.commands.spec.shell import (
    SHELL_SPECS,
    ShellParse,
    parse_shell_options,
)
from mirage.commands.spec.synopsis import SYNOPSES
from mirage.commands.spec.types import CommandSpec
from mirage.context import get_current_evaluation
from mirage.execution.process.constants import WORKSPACE_MACHINE
from mirage.execution.process.table import ProcessTable
from mirage.execution.types import MachineResources
from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.runtime.base import Runtime
from mirage.runtime.constants import EXTERNAL_COMMANDS
from mirage.runtime.types import RouteDecision, RuntimeIdentity
from mirage.shell.bytes import encode_text
from mirage.workspace.executor.builtins.jobspec import names_machine
from mirage.workspace.types import ExecutionNode

logger = logging.getLogger(__name__)

# The header of the column that says which machine a row is about.
MACHINE_HEADER = "MACHINE"


@dataclass(frozen=True, slots=True)
class MachineScope:
    """The machines a command answers for, by id as ``ps`` shows them.

    Args:
        ids (tuple[str, ...]): the machines, in ``machines:`` order and
            the host last.
        picked (bool): the line named one, with ``--machine`` or by its
            placement.
        workspace (bool): the workspace answers too, ahead of them.
    """

    ids: tuple[str, ...]
    picked: bool = False
    workspace: bool = False

    @property
    def several(self) -> bool:
        """Whether rows need to say which machine they are about."""
        return len(self.ids) + self.workspace > 1


def in_scope(scope: MachineScope, machine: str) -> bool:
    """Whether a process on ``machine`` is in a scope: a machine in it,
    or Mirage's own unless the line picked another machine.

    Args:
        scope (MachineScope): the machines.
        machine (str): the machine as ``ps`` shows it.
    """
    if machine == WORKSPACE_MACHINE:
        return scope.workspace or not scope.picked
    return machine in scope.ids


def _reach_of(runtime: RuntimeIdentity | None) -> str:
    """How far a runtime reaches.

    Args:
        runtime (RuntimeIdentity | None): the runtime.
    """
    return getattr(runtime, "reach", "workspace")


def _default_machine(
    routing: RouteDecision[RuntimeIdentity], every: list[str], host: str
) -> str:
    """The machine programs run on by default: the one taking programs
    no name captures, else the first that captures any.

    Args:
        routing (RouteDecision): the line's placement.
        every (list[str]): every machine in scope, none empty.
        host (str): the host's id.
    """
    bindings = routing.bindings
    for runtime in (bindings.get(EXTERNAL_COMMANDS), *bindings.values()):
        reach = _reach_of(runtime)
        if reach == "process":
            return host
        if runtime is None or reach != "remote":
            continue
        try:
            found = Runtime.require(runtime).machine_for(
                Context(machine=routing.machine)
            )
        except Exception as exc:
            logger.debug("no default machine: %s", exc)
            continue
        if found is not None:
            return str(found)
    return every[0]


def machine_scope(
    processes: ProcessTable, name: str | None, workspace: bool = False
) -> MachineScope | None:
    """Which machines a command answers for: the one ``--machine`` or
    the line's placement names; in a command substitution, whose reader
    is a script, only the default one, the workspace when there is no
    machine; otherwise every one. The host
    counts only while a runtime runs programs on it, so a workspace that
    runs none says nothing of it.

    Args:
        processes (ProcessTable): the workspace's processes.
        name (str | None): the option's value, None for none.
        workspace (bool): the command also answers for the workspace,
            which is ``mirage`` to ``--machine`` as it is to ``ps``.

    Returns:
        MachineScope | None: the machines; None when ``name`` names none.
    """
    context = get_current_evaluation()
    frame = context.frame if context is not None else None
    routing = frame.routing if frame is not None else None
    every = list(processes.machine_ids() if processes.machine_ids else [])
    host = str(processes.machine)
    if routing is not None and any(
        _reach_of(runtime) == "process"
        for runtime in routing.bindings.values()
    ):
        every.append(host)
    if name is not None:
        if workspace and names_machine(WORKSPACE_MACHINE, name):
            return MachineScope((), True, True)
        named = [machine for machine in every if names_machine(machine, name)]
        return MachineScope((named[0],), True) if named else None
    if routing is not None and routing.machine is not None:
        placed = [
            machine
            for machine in every
            if names_machine(machine, routing.machine)
        ]
        if placed:
            return MachineScope((placed[0],), True)
    substituted = (
        frame is not None and frame.substitution and routing is not None
    )
    if substituted and routing is not None and len(every) > 1:
        return MachineScope((_default_machine(routing, every, host),))
    return MachineScope(
        tuple(every), workspace=workspace and not (substituted and every)
    )


def process_scope(
    processes: ProcessTable, name: str | None
) -> MachineScope | None:
    """Which machines a process search looks at: those ``machine_scope``
    picks, or Mirage's own alone for ``mirage``, as ``ps`` names them.

    Args:
        processes (ProcessTable): the workspace's processes.
        name (str | None): the option's value, None for none.

    Returns:
        MachineScope | None: the machines; None when ``name`` names none.
    """
    if name is not None and names_machine(WORKSPACE_MACHINE, name):
        return MachineScope((), True, True)
    return machine_scope(processes, name)


async def read_machines(
    processes: ProcessTable, scope: MachineScope, name: str, cpu: bool = False
) -> tuple[list[MachineResources], str]:
    """Read every machine of a scope at once; one that does not answer
    leaves its rows out and says so.

    Args:
        processes (ProcessTable): the workspace's processes.
        scope (MachineScope): the machines.
        name (str): the command, which the diagnostics name.
        cpu (bool): sample the processors too.

    Returns:
        tuple[list[MachineResources], str]: what the machines that
        answered hold, and the diagnostics of those that did not.
    """
    reader = processes.machine_resources
    if reader is None:
        return [], "".join(
            f"{name}: {machine}: machine did not answer\n"
            for machine in scope.ids
        )
    answers = await asyncio.gather(
        *(reader(machine, cpu) for machine in scope.ids),
        return_exceptions=True,
    )
    rows: list[MachineResources] = []
    errors: list[str] = []
    for machine, answer in zip(scope.ids, answers, strict=True):
        if isinstance(answer, MachineResources):
            rows.append(answer)
            continue
        if not isinstance(answer, Exception):
            raise answer
        logger.debug("%s: %s not read: %s", name, machine, answer)
        errors.append(f"{name}: {machine}: machine did not answer\n")
    return rows, "".join(errors)


def _ended(spec: CommandSpec, words: list[str], parse: ShellParse) -> bool:
    """Whether a parse of ``words`` stopped at a ``--`` that ends the
    options, not one an option took as its value.

    Args:
        spec (CommandSpec): the command's options.
        words (list[str]): the words parsed.
        parse (ShellParse): how they read.
    """
    taken = len(words) - len(parse.operands)
    return (
        taken > 0
        and words[taken - 1] == "--"
        and parse_shell_options(spec, words[: taken - 1]).needs_value is None
    )


def permuted_options(spec: CommandSpec, words: list[str]) -> ShellParse:
    """Read a line's options wherever they stand among its operands, as
    getopt does; every word after a ``--`` is an operand.

    Args:
        spec (CommandSpec): the command's options.
        words (list[str]): its words, its name excluded.
    """
    parse = parse_shell_options(spec, words)
    read = words
    operands: list[str] = []
    while (
        parse.operands
        and parse.invalid is None
        and parse.needs_value is None
        and parse.unexpected_value is None
        and not _ended(spec, read, parse)
    ):
        operands.append(parse.operands[0])
        rest = parse.operands[1:]
        if not rest:
            return replace(parse, operands=operands)
        read = rest
        following = parse_shell_options(spec, rest)
        parse = replace(
            following,
            flags={**parse.flags, **following.flags},
            given=[*parse.given, *following.given],
        )
    return replace(parse, operands=[*operands, *parse.operands])


def option_refusal(name: str, parse: ShellParse, page: bool = True) -> str:
    """What a command says of an option it could not take, as the
    getopt-driven tools do; empty when every option was fine.

    Args:
        name (str): the command.
        parse (ShellParse): how its options read.
        page (bool): follow the line with the command's usage page.
    """
    if parse.invalid is not None:
        said = (
            f"{name}: unrecognized option '{parse.invalid}'\n"
            if parse.invalid.startswith("--")
            else f"{name}: invalid option -- '{parse.invalid}'\n"
        )
    elif parse.needs_value is not None:
        said = (
            f"{name}: option '{parse.needs_value}' requires an argument\n"
            if parse.needs_value.startswith("--")
            else f"{name}: option requires an argument -- "
            f"'{parse.needs_value}'\n"
        )
    elif parse.unexpected_value is not None:
        said = (
            f"{name}: option '{parse.unexpected_value.partition('=')[0]}' "
            "doesn't allow an argument\n"
        )
    else:
        return ""
    return said + (f"\n{usage_page(name)}" if page else "")


def usage_page(name: str) -> str:
    """A command's usage page.

    Args:
        name (str): the command.
    """
    return render_help(name, SHELL_SPECS[name], synopsis=SYNOPSES[name])


def machine_named(words: list[str]) -> str | None:
    """The machine words that ``picks_machine`` took name, None for none.

    Args:
        words (list[str]): the command's words, its name excluded.
    """
    if not words:
        return None
    return words[0].partition("=")[2] if len(words) == 1 else words[1]


def rows_result(
    cmd_str: str, lines: list[str], errors: str
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """A view's answer: its rows, and what a machine that did not answer
    left to say.

    Args:
        cmd_str (str): the command line.
        lines (list[str]): the rows.
        errors (str): the diagnostics, empty for none.
    """
    code = 1 if errors else 0
    err = encode_text(errors) or None
    return (
        encode_text("".join(f"{line}\n" for line in lines)),
        IOResult(exit_code=code, stderr=err),
        ExecutionNode(command=cmd_str, exit_code=code, stderr=err or b""),
    )


def with_machine(line: str, machine: str, width: int = 0) -> str:
    """A row with the machine it is about on its right, past every
    existing column, so a reader of those columns reads the same.

    Args:
        line (str): the row.
        machine (str): the machine.
        width (int): how far the row's columns reach.
    """
    return f"{line.rstrip().ljust(width)}  {machine}"
