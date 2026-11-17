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

import dataclasses
from collections.abc import Sequence

from mirage.commands.builtin.general.interpreter import run_output
from mirage.commands.spec.help import render_help
from mirage.commands.spec.shell import SHELL_SPECS
from mirage.commands.spec.standard import version_line
from mirage.commands.spec.synopsis import SYNOPSES
from mirage.context import (
    current_caller,
    reset_caller,
    set_program_invocation,
    set_traits,
)
from mirage.execution.process.types import ProcessTraits
from mirage.io import IOResult
from mirage.io.stream import ensure_stream
from mirage.io.types import ByteSource
from mirage.runtime.types import OutputFn, RunResult
from mirage.shell.bytes import encode_text
from mirage.shell.console import Channel, JobConsole
from mirage.shell.constants import SIGHUP
from mirage.shell.join import shell_join
from mirage.workspace.expand.types import ExecuteFn
from mirage.workspace.lookup.constants import (
    DEFAULT_NICENESS,
    LOWEST_PRIORITY,
    PROGRAM_WRAPPERS,
    nice_adjustment,
    read_wrapper,
)
from mirage.workspace.lookup.lookup import execs
from mirage.workspace.lookup.types import WrapperAnswer
from mirage.workspace.mount import MountRegistry
from mirage.workspace.session import SessionState
from mirage.workspace.types import ExecutionNode


class _Relay(JobConsole):
    """A console that hands each chunk a line writes on as it comes.

    Args:
        output (OutputFn): takes stdout.
        errors (OutputFn): takes stderr.
    """

    def __init__(self, output: OutputFn, errors: OutputFn) -> None:
        super().__init__()
        self._output = output
        self._errors = errors

    async def emit(self, channel: Channel, data: bytes) -> None:
        await (self._output if channel == Channel.STDOUT else self._errors)(
            data
        )


def _run_program(
    execute_fn: ExecuteFn,
    name: str,
    line: str,
    session: SessionState,
    stdin: ByteSource | None,
    traits: ProcessTraits,
    warned: str = "",
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run a wrapper's program in Mirage, as the program it execs, its
    output handed over as it runs: the process it runs as, and all it
    starts, carry what the wrapper changed.

    Args:
        execute_fn (ExecuteFn): runs a line in the session.
        name (str): the wrapper, which the node records.
        line (str): the program's words, quoted.
        session (SessionState): the session it runs in.
        stdin (ByteSource | None): its input.
        traits (ProcessTraits): what the wrappers around it changed.
        warned (str): what the wrapper says before it runs the program.
    """
    node = ExecutionNode(command=name)

    async def run(output: OutputFn, errors: OutputFn) -> RunResult:
        if warned:
            await errors(encode_text(warned))
        token = set_program_invocation(session)
        worn = set_traits(traits)
        try:
            ran = await execute_fn(
                line,
                session_id=session.session_id,
                stdin=stdin,
                sink=_Relay(output, errors),
            )
            if ran.stdout is not None:
                async for chunk in ensure_stream(ran.stdout):
                    await output(chunk)
            said = await ran.materialize_stderr()
        finally:
            reset_caller(worn)
            reset_caller(token)
        node.exit_code = ran.exit_code
        return RunResult(
            stdout=b"", stderr=said or None, exit_code=ran.exit_code
        )

    stdout, io = run_output(run)
    return stdout, io, node


def handle_wrapper(
    execute_fn: ExecuteFn,
    name: str,
    args: Sequence[str],
    session: SessionState,
    registry: MountRegistry,
    stdin: ByteSource | None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """A wrapper Mirage runs (``nice``, ``nohup``, ``setsid``,
    ``stdbuf``, ``ionice``): it answers for itself (``nice`` alone, a bad
    option, a program it cannot exec), or execs its program with what it
    changes (``wrapper_traits``). The runner it runs as, when it is a
    job's or a stage's one command, becomes the program; the program is
    judged, placed and run as any command is, and a machine with
    processes of its own is handed the wrapper's words before it.

    Args:
        execute_fn (ExecuteFn): runs a line in the session.
        name (str): the wrapper.
        args (Sequence[str]): its words, argv[0] excluded.
        session (SessionState): the session it runs in.
        registry (MountRegistry): mount registry (command registration).
        stdin (ByteSource | None): its input.
    """
    caller = current_caller()
    answer = wrapper_answer(
        name, args, session, registry, caller.traits.niceness
    )
    if answer.runs_from is None:
        err = encode_text(answer.stderr)
        return (
            encode_text(answer.stdout) if answer.stdout else None,
            IOResult(exit_code=answer.exit_code, stderr=err or None),
            ExecutionNode(
                command=name, exit_code=answer.exit_code, stderr=err
            ),
        )
    traits, warned = wrapper_traits(
        name, args, answer.runs_from, caller.traits
    )
    line = shell_join(args[answer.runs_from :])
    if caller.process is not None and caller.process.wrap(traits, line):
        traits = dataclasses.replace(traits, leads=False)
    return _run_program(execute_fn, name, line, session, stdin, traits, warned)


def wrapper_traits(
    name: str,
    args: Sequence[str],
    at: int,
    traits: ProcessTraits,
) -> tuple[ProcessTraits, str]:
    """What a wrapper changes for the program at ``at`` in its words, over
    the traits it runs under, and what it warns first: ``nice`` the
    niceness (10 more, or its adjustment, never past 19; a negative one
    is refused, as for a user who is not root), ``nohup`` HUP ignored,
    ``setsid`` a group and session of its own. Each records its words for
    a machine with processes of its own.

    Args:
        name (str): a ``PROGRAM_WRAPPERS`` name.
        args (Sequence[str]): its words, argv[0] excluded.
        at (int): where its program stands in them.
        traits (ProcessTraits): the traits it runs under.
    """
    worn = dataclasses.replace(
        traits, wrappers=(*traits.wrappers, name, *args[:at])
    )
    if name == "nice":
        adjustment = nice_adjustment(args[:at])
        if adjustment is not None and adjustment < 0:
            return worn, "nice: cannot set niceness: Permission denied\n"
        step = DEFAULT_NICENESS if adjustment is None else adjustment
        level = min(traits.niceness + step, LOWEST_PRIORITY)
        return dataclasses.replace(worn, niceness=level), ""
    if name == "nohup":
        return dataclasses.replace(worn, ignores=worn.ignores | {SIGHUP}), ""
    if name == "setsid":
        return dataclasses.replace(worn, leads=True), ""
    return worn, ""


def wrapper_refusal(
    name: str,
    args: Sequence[str],
    session: SessionState,
    registry: "MountRegistry",
) -> tuple[int, str] | None:
    """The status and stderr GNU's wrapper answers instead of running
    its program: a bad option, or a word it cannot exec (``nice cd``).

    Args:
        name (str): a ``PROGRAM_WRAPPERS`` name.
        args (Sequence[str]): its words, argv[0] excluded.
        session (SessionState): shell session (function table).
        registry (MountRegistry): mount registry (command registration).
    """
    grammar = PROGRAM_WRAPPERS[name]
    at, error = read_wrapper(name, args)
    if error is not None:
        return grammar.status, error
    if at is None:
        return None
    inner = args[at]
    if inner not in PROGRAM_WRAPPERS and not execs(inner, session, registry):
        return 127, grammar.missing.format(inner)
    return None


def _usage(name: str, line: str, status: int) -> WrapperAnswer:
    return WrapperAnswer(
        exit_code=status,
        stderr=f"{line}\nTry '{name} --help' for more information.\n",
    )


def _help_word(args: Sequence[str]) -> str | None:
    """The ``--help`` or ``--version`` a wrapper's options stopped at.

    Args:
        args (Sequence[str]): its words.
    """
    for word in args:
        if word == "--" or not word.startswith("-"):
            return None
        if len(word) > 2 and "--help".startswith(word):
            return "--help"
        if len(word) > 2 and "--version".startswith(word):
            return "--version"
    return None


def _niceness(args: Sequence[str], niceness: int) -> WrapperAnswer:
    """``nice`` with nothing to run: the niceness it runs at, an
    adjustment with nothing to run refused.

    Args:
        args (Sequence[str]): its words, argv[0] excluded.
        niceness (int): the niceness of the process it runs as.
    """
    if nice_adjustment(args) is not None:
        return _usage(
            "nice", "nice: a command must be given with an adjustment", 125
        )
    return WrapperAnswer(stdout=f"{niceness}\n")


def wrapper_answer(
    name: str,
    args: Sequence[str],
    session: SessionState,
    registry: "MountRegistry",
    niceness: int = 0,
) -> WrapperAnswer:
    """What a wrapper Mirage runs does: refuse the line, say what it is,
    print the niceness, or run its program (``runs_from``).

    Args:
        name (str): a ``PROGRAM_WRAPPERS`` name.
        args (Sequence[str]): its words, argv[0] excluded.
        session (SessionState): shell session (function table).
        registry (MountRegistry): mount registry (command registration).
        niceness (int): the niceness of the process it runs as.
    """
    refused = wrapper_refusal(name, args, session, registry)
    if refused is not None:
        code, said = refused
        return WrapperAnswer(exit_code=code, stderr=said)
    at = read_wrapper(name, args)[0]
    if at is not None:
        return WrapperAnswer(runs_from=at)
    word = _help_word(args)
    if word == "--version":
        return WrapperAnswer(stdout=version_line(name).decode())
    if word == "--help":
        page = render_help(name, SHELL_SPECS[name], synopsis=SYNOPSES[name])
        return WrapperAnswer(stdout=page)
    if name == "nice":
        return _niceness(args, niceness)
    if name == "setsid":
        return _usage(name, "setsid: no command specified", 1)
    return _usage(name, f"{name}: missing operand", 125)
