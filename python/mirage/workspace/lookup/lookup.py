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
from collections.abc import Iterator, Mapping, Sequence
from typing import TYPE_CHECKING

from mirage.commands.spec.compile import compile_spec
from mirage.commands.spec.help import render_help
from mirage.commands.spec.shell import SHELL_SPECS
from mirage.commands.spec.standard import version_line
from mirage.commands.spec.synopsis import SYNOPSES
from mirage.runtime.constants import EXTERNAL_COMMANDS
from mirage.runtime.language import LanguageRuntime
from mirage.runtime.mixin import LineExecutorMixin, ProcessExecutorMixin
from mirage.runtime.types import RouteDecision, RuntimeIdentity
from mirage.utils.quote import shell_quote
from mirage.workspace.lookup.constants import (
    CAPTURABLE_BUILTINS,
    DEFAULT_NICENESS,
    EXEC_WRAPPERS,
    INTERPRETER_NAMES,
    KEYWORDS,
    LOWEST_PRIORITY,
    MACHINE_ONLY_BUILTINS,
    MACHINE_VIEW,
    NAMESPACE_COMMANDS,
    PROGRAM_WRAPPERS,
    ROUTED_COMMANDS,
    RUNNERS,
    SHELL_NAMES,
    SHELL_ONLY_BUILTINS,
    nice_adjustment,
    read_wrapper,
)
from mirage.workspace.lookup.types import Consumer, WrapperAnswer
from mirage.workspace.session import SessionState

if TYPE_CHECKING:
    from mirage.workspace.mount import MountRegistry


def is_tool(name: str, session: SessionState) -> bool:
    """Whether a command word is a tool the allow lists govern.

    Every named command is a subject, shell builtins included: an allow
    list stating ``cat`` leaves no ``echo`` and no ``cd``. Two kinds of
    word are not, because neither is a name the list could hold: a path
    being executed (its lines are each checked as they run), and the
    agent's own function where the function is what runs, which in this
    shell means a name no builtin owns (builtins shadow functions), and
    its body's lines each pass the gate themselves.

    Args:
        name (str): expanded command name.
        session (SessionState): the shell session running the line.
    """
    if "/" in name:
        return False
    return not (name in session.functions and name not in SHELL_NAMES)


def runs_programs(
    bindings: Mapping[str, RuntimeIdentity | None],
) -> bool:
    """Whether a line's placement runs programs anywhere past the
    workspace: a machine, or the host.

    Args:
        bindings (Mapping[str, RuntimeIdentity | None]): the line's
            command bindings.
    """
    return any(
        getattr(runtime, "reach", "workspace") != "workspace"
        for runtime in bindings.values()
    )


def picks_machine(words: Sequence[str]) -> bool:
    """Whether a command's words are at most one ``--machine``, all that
    a view of its machines reads; any other option is the program's.

    Args:
        words (Sequence[str]): its words, its name excluded.
    """
    return (
        not words
        or (len(words) == 1 and words[0].startswith("--machine="))
        or (len(words) == 2 and words[0] == "--machine")
    )


def runtime_refused(
    name: str,
    session: SessionState,
    registry: "MountRegistry",
    routing: RouteDecision[RuntimeIdentity] | None = None,
) -> bool:
    """Whether routing explicitly refused the external runtime for ``name``."""
    if routing is None:
        return False
    bindings = routing.bindings
    key = name if name in bindings else EXTERNAL_COMMANDS
    return (
        key in bindings
        and bindings[key] is None
        and lookup(name, session, registry) is Consumer.EXTERNAL
    )


def _is_native(runtime: RuntimeIdentity | None, name: str) -> bool:
    """Whether the runtime runs the name as a native program.

    A language runtime that also runs processes (local) still
    interprets its own language's names (python3), so those stay the
    session's builtin; any other name it captures runs natively.

    Args:
        runtime (Runtime | None): the runtime bound to the name.
        name (str): expanded command name.
    """
    if not isinstance(runtime, (LineExecutorMixin, ProcessExecutorMixin)):
        return False
    return not (
        isinstance(runtime, LanguageRuntime) and name in runtime.commands
    )


def routed_consumer(
    name: str,
    args: Sequence[str],
    session: SessionState,
    registry: "MountRegistry",
    routing: RouteDecision[RuntimeIdentity] | None,
) -> tuple[Consumer, RouteDecision[RuntimeIdentity] | None]:
    """``lookup``'s answer, with a wrapper no Mirage layer owns bound to
    the runtime that captures its program by name (``nice gcc``).

    Args:
        name (str): expanded command name.
        args (Sequence[str]): its words, argv[0] excluded.
        session (SessionState): shell session (function table).
        registry (MountRegistry): mount registry (command registration).
        routing (RouteDecision | None): the line's placement.
    """
    if (
        name == MACHINE_VIEW
        and routing is not None
        and name not in routing.bindings
        and runs_programs(routing.bindings)
        and picks_machine(args)
    ):
        return Consumer.SESSION, routing
    consumer = lookup(name, session, registry, routing)
    if routing is None or not _outside_mirage(consumer):
        return consumer, routing
    program = _wrapped(name, args, routing.bindings)
    if program is None:
        return consumer, routing
    bindings = {**routing.bindings, name: routing.bindings[program]}
    return Consumer.EXTERNAL, dataclasses.replace(routing, bindings=bindings)


def runs_on_machine(
    registry: "MountRegistry",
    words: Sequence[str | None],
    session: SessionState,
    routing: RouteDecision[RuntimeIdentity],
) -> bool:
    """Whether a job's one program runs past the workspace, with a pid
    of its own there: what the executor answers when it runs the word,
    so a wrapper or any program no layer of the workspace holds counts
    as one a name captures does.

    Args:
        registry (MountRegistry): mount registry (command registration).
        words (Sequence[str | None]): the program's words, None for one
            only known when it runs.
        session (SessionState): shell session (function table).
        routing (RouteDecision): the line's placement.
    """
    head = str(words[0])
    runtime = routing.bindings.get(head, routing.fallback)
    args = [word for word in words[1:] if word is not None]
    if (
        head not in routing.bindings
        and len(args) == len(words) - 1
        and mirage_program_at(head, args, session, registry, routing) is None
    ):
        consumer, placed = routed_consumer(
            head, args, session, registry, routing
        )
        if consumer is Consumer.EXTERNAL and placed is not None:
            runtime = placed.bindings.get(
                head, placed.bindings.get(EXTERNAL_COMMANDS)
            )
    return getattr(runtime, "reach", "workspace") != "workspace"


def without_capture(
    routing: RouteDecision[RuntimeIdentity] | None, name: str
) -> RouteDecision[RuntimeIdentity] | None:
    """The line's placement with no runtime capturing ``name``, which is
    how ``builtin`` runs its target: the shell's own builtin, though a
    runtime takes the name by itself (``builtin kill``).

    Args:
        routing (RouteDecision | None): the line's placement.
        name (str): the builtin's name.
    """
    if routing is None or name not in routing.bindings:
        return routing
    bindings = {k: v for k, v in routing.bindings.items() if k != name}
    return dataclasses.replace(routing, bindings=bindings)


def mirage_program_at(
    name: str,
    args: Sequence[str],
    session: SessionState,
    registry: "MountRegistry",
    routing: RouteDecision[RuntimeIdentity] | None,
) -> int | None:
    """Where a wrapper's program stands in its words when Mirage runs
    that program itself, without the wrapper (``nice grep``); None
    otherwise.

    Args:
        name (str): expanded command name.
        args (Sequence[str]): its words, argv[0] excluded.
        session (SessionState): shell session (function table).
        registry (MountRegistry): mount registry (command registration).
        routing (RouteDecision | None): the line's placement.
    """
    bindings: Mapping[str, RuntimeIdentity | None] = (
        routing.bindings if routing is not None else registry.runtime_bindings
    )
    if (
        name not in PROGRAM_WRAPPERS
        or name in bindings
        or not _outside_mirage(lookup(name, session, registry, routing))
        or _wrapped(name, args, bindings) is not None
    ):
        return None
    at = read_wrapper(name, args)[0]
    if at is None:
        return None
    inner = args[at]
    if inner in PROGRAM_WRAPPERS:
        deeper = mirage_program_at(
            inner, args[at + 1 :], session, registry, routing
        )
        return None if deeper is None else at
    if _outside_mirage(lookup(inner, session, registry, routing)):
        return None
    if inner in INTERPRETER_NAMES and not isinstance(
        bindings.get(inner), LanguageRuntime
    ):
        return None
    return at


def wrapper_runs_outside(
    name: str,
    args: Sequence[str],
    session: SessionState,
    registry: "MountRegistry",
    routing: RouteDecision[RuntimeIdentity] | None,
) -> bool:
    """Whether a wrapper goes to a runtime with its program under it
    (``nohup python3`` on a machine), so Mirage never runs that program
    itself.

    Args:
        name (str): expanded command name.
        args (Sequence[str]): its words, argv[0] excluded.
        session (SessionState): shell session (function table).
        registry (MountRegistry): mount registry (command registration).
        routing (RouteDecision | None): the line's placement.
    """
    return (
        name in PROGRAM_WRAPPERS
        and mirage_program_at(name, args, session, registry, routing) is None
        and routed_consumer(name, args, session, registry, routing)[0]
        is Consumer.EXTERNAL
    )


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


def _niceness(args: Sequence[str]) -> WrapperAnswer:
    """``nice`` followed down a chain of itself to the end: the niceness
    it comes to, an adjustment with nothing to run refused.

    Args:
        args (Sequence[str]): the words after the outermost ``nice``.
    """
    level = 0
    warned: list[str] = []
    words = list(args)
    while True:
        at = read_wrapper("nice", words)[0]
        adjustment = nice_adjustment(words[:at] if at is not None else words)
        if at is None and adjustment is not None:
            return _usage(
                "nice", "nice: a command must be given with an adjustment", 125
            )
        if adjustment is not None and adjustment < 0:
            warned.append("nice: cannot set niceness: Permission denied\n")
        elif adjustment is not None:
            level = min(level + adjustment, LOWEST_PRIORITY)
        elif at is not None:
            level = min(level + DEFAULT_NICENESS, LOWEST_PRIORITY)
        if at is None:
            break
        words = words[at + 1 :]
    return WrapperAnswer(stdout=f"{level}\n", stderr="".join(warned))


def _ends_bare(args: Sequence[str]) -> bool:
    """Whether a chain of ``nice`` ends with nothing left to run.

    Args:
        args (Sequence[str]): the words after the outermost ``nice``.
    """
    words = list(args)
    while True:
        at = read_wrapper("nice", words)[0]
        if at is None:
            return True
        if words[at] != "nice":
            return False
        words = words[at + 1 :]


def wrapper_answer(
    name: str,
    args: Sequence[str],
    session: SessionState,
    registry: "MountRegistry",
) -> WrapperAnswer:
    """What a wrapper does with no program it can hand to a Mirage layer:
    refuse the line, say what it is, print the niceness, or run a path or
    another wrapper through the shell.

    Args:
        name (str): a ``RUNNERS`` name.
        args (Sequence[str]): its words, argv[0] excluded.
        session (SessionState): shell session (function table).
        registry (MountRegistry): mount registry (command registration).
    """
    refused = wrapper_refusal(name, args, session, registry)
    if refused is not None:
        code, said = refused
        return WrapperAnswer(exit_code=code, stderr=said)
    at = read_wrapper(name, args)[0]
    if at is not None:
        if name == "nice" and args[at] == "nice" and _ends_bare(args):
            return _niceness(args)
        return WrapperAnswer(runs_from=at)
    word = _help_word(args)
    if word == "--version":
        return WrapperAnswer(stdout=version_line(name).decode())
    if word == "--help":
        page = render_help(name, SHELL_SPECS[name], synopsis=SYNOPSES[name])
        return WrapperAnswer(stdout=page)
    if name == "nice":
        return _niceness(args)
    if name == "setsid":
        return _usage(name, "setsid: no command specified", 1)
    return _usage(name, f"{name}: missing operand", 125)


def _outside_mirage(consumer: Consumer) -> bool:
    """Whether no Mirage layer runs the command.

    Args:
        consumer (Consumer): ``lookup``'s answer.
    """
    return consumer in (Consumer.EXTERNAL, Consumer.UNKNOWN)


def _wrapped(
    name: str,
    args: Sequence[str],
    bindings: Mapping[str, RuntimeIdentity | None],
) -> str | None:
    """The program a wrapper runs, nested wrappers followed, when a
    runtime captures it by name and runs it natively.

    Args:
        name (str): the wrapper's name.
        args (Sequence[str]): its words, argv[0] excluded.
        bindings (Mapping[str, RuntimeIdentity | None]): the line's
            command bindings.
    """
    if name not in PROGRAM_WRAPPERS or name in bindings:
        return None
    at = read_wrapper(name, args)[0]
    if at is None:
        return None
    inner = args[at]
    if _is_native(bindings.get(inner), inner):
        return inner
    return _wrapped(inner, args[at + 1 :], bindings)


def _layers(
    name: str,
    session: SessionState,
    registry: "MountRegistry",
    routing: RouteDecision[RuntimeIdentity] | None = None,
) -> Iterator[Consumer]:
    """Yield every layer holding the name, most-preferred first.

    The one place precedence is written down: ``lookup`` reads the first
    yield and ``lookup_all`` reads all of them. Lazy on purpose, so the
    winner costs exactly what it did before the split (a name an
    installed CLI answers never reaches the mount lookup). A profile's
    allow list does not narrow it: a word the list leaves out is found,
    and the policy gate refuses it.

    A default runtime skipped for a missing extra leaves its names in
    ``registry.runtime_unavailable``, which the ``@external`` fallback
    never takes. TypeScript builds every default entry, so it has no
    such table.

    Args:
        name (str): expanded command name.
        session (SessionState): shell session (function table).
        registry (MountRegistry): mount registry (command registration).
        routing (RouteDecision | None): the line's placement; None
            outside a line, where the static bindings answer.
    """
    found = False
    bindings: Mapping[str, RuntimeIdentity | None] = (
        routing.bindings if routing is not None else registry.runtime_bindings
    )
    bound = bindings.get(name)
    native = _is_native(bound, name)
    refused = runtime_refused(name, session, registry, routing)
    if name in SHELL_NAMES and (
        name not in MACHINE_ONLY_BUILTINS or runs_programs(bindings)
    ):
        found = True
        yield (
            Consumer.EXTERNAL
            if (native or refused) and name in CAPTURABLE_BUILTINS
            else Consumer.SESSION
        )
    if name in NAMESPACE_COMMANDS:
        found = True
        yield Consumer.NAMESPACE
    if name in session.functions:
        found = True
        yield Consumer.FUNCTION
    if registry.clis.get(name) is not None:
        found = True
        yield Consumer.CLI
    if (native or refused) and name not in SHELL_NAMES:
        found = True
        yield Consumer.EXTERNAL
    if (
        name in ROUTED_COMMANDS
        or registry.mount_for_command(runs_as(name, registry)) is not None
    ):
        found = True
        yield Consumer.MOUNT
    fallback = bindings.get(EXTERNAL_COMMANDS)
    fallback_native = isinstance(
        fallback, (LineExecutorMixin, ProcessExecutorMixin)
    )
    if (
        not found
        and name not in bindings
        and name not in registry.runtime_unavailable
        and (fallback_native or refused)
    ):
        yield Consumer.EXTERNAL


def lookup(
    name: str,
    session: SessionState,
    registry: "MountRegistry",
    routing: RouteDecision[RuntimeIdentity] | None = None,
) -> Consumer:
    """Route a command name to the layer that consumes it.

    Order mirrors dispatch precedence: shell builtins shadow functions,
    functions shadow installed CLIs, CLIs shadow mount commands, and a
    name nobody registers is UNKNOWN (command not found). Install-time
    collision rules keep the CLI arm honest: a CLI may not take a shell
    builtin's or a general command's name, so the only shadowing a CLI
    can actually exert is over a mount-specific custom command.

    The full landscape, in precedence order. The column to watch is
    what resolves the name: session or workspace state for the named
    layers, operand paths for mounts::

        Consumer   Example              Resolved by          Words
        SESSION    cd, echo, export     name in SHELL_NAMES  shell-expanded
        NAMESPACE  ln -s, readlink      NAMESPACE_COMMANDS   shell-expanded
        FUNCTION   deploy() {..}        session.functions    shell-expanded
        CLI        slack message send   registry.clis        shell-expanded
        MOUNT      grep, cat, du        operand paths        pushdown
        UNKNOWN    bogus                nobody               untouched, 127

    Named process captures select EXTERNAL before mount commands. The
    EXTERNAL_COMMANDS capture handles names no preceding layer owns.

    This is the winner only. A name can sit in more than one layer at
    once (a function shadowing an installed CLI); ``lookup_all`` reports
    them all, which is what ``type -a`` prints. Reading one item off the
    generator is what makes that sharing free: the lookups after the
    winner never run, so dispatch pays exactly what it did when this was
    a chain of ``if`` arms.

    Args:
        name (str): expanded command name.
        session (SessionState): shell session (function table).
        registry (MountRegistry): mount registry (command registration).
    """
    return next(_layers(name, session, registry, routing), Consumer.UNKNOWN)


def lookup_all(
    name: str, session: SessionState, registry: "MountRegistry"
) -> list[Consumer]:
    """Every layer holding the name, most-preferred first.

    Empty when nothing holds it, where ``lookup`` says UNKNOWN. Only
    introspection (``type -a``, ``which -a``) needs this: dispatch runs
    the winner and never asks what it shadowed.

    Args:
        name (str): expanded command name.
        session (SessionState): shell session (function table).
        registry (MountRegistry): mount registry (command registration).
    """
    return list(_layers(name, session, registry))


def program(
    name: str, session: SessionState, registry: "MountRegistry"
) -> Consumer | None:
    """The layer a name runs from as a program, None when it is none.

    A program is what a real system ships as a file on PATH, so it has
    one under ``/usr/bin`` here: every mount, namespace and CLI command,
    every name a runtime captures by name, and each builtin a real
    system also finds on disk (echo, test, xargs). The shell's own words
    (cd, export, history: ``SHELL_ONLY_BUILTINS``), reserved words,
    functions and aliases have no file, and a shell word keeps none
    when a mount registers the same name, since the builtin is what
    runs. Nor does a name only the external fallback capture takes: it
    takes any word, so like bash's ``command_not_found_handle`` it runs
    a name without making it a program. An interpreter (python3, node)
    is a program only where a language runtime is bound to it: without
    one it answers 127, as it does on a system that never installed it.
    A function shadowing a program leaves the file in place, as it does
    on PATH. ``lscpu`` is one wherever its view of the machines answers
    it: a runtime runs programs and none takes the name itself.

    Args:
        name (str): the command word.
        session (SessionState): shell session (function table, allow
            list).
        registry (MountRegistry): mount registry (command registration).
    """
    if "/" in name or name in KEYWORDS:
        return None
    for consumer in _layers(name, session, registry):
        if consumer is Consumer.FUNCTION:
            continue
        if consumer is Consumer.SESSION and name in SHELL_ONLY_BUILTINS:
            return None
        if (
            consumer is Consumer.SESSION
            and name in INTERPRETER_NAMES
            and not isinstance(
                registry.runtime_bindings.get(name), LanguageRuntime
            )
        ):
            return None
        if (
            consumer is Consumer.EXTERNAL
            and name not in registry.runtime_bindings
        ):
            return None
        return consumer
    if name == MACHINE_VIEW and runs_programs(registry.runtime_bindings):
        return Consumer.SESSION
    return Consumer.UNKNOWN if name in RUNNERS else None


def execs(name: str, session: SessionState, registry: "MountRegistry") -> bool:
    """Whether a builtin that execs its operand (xargs, timeout) finds it.

    GNU execs the name, so a shell word with no file on PATH (cd,
    export) is missing there, as is a name nothing provides. A function
    runs too, where it is what the name runs (a shell word shadows
    one): mirage runs the line in the shell, which is how these reach
    it. A path is left to the run, which reports on it.

    Args:
        name (str): the command word.
        session (SessionState): the session it would run in.
        registry (MountRegistry): mount registry (command registration).
    """
    return (
        "/" in name
        or program(name, session, registry) is not None
        or lookup(name, session, registry)
        in (Consumer.FUNCTION, Consumer.EXTERNAL)
    )


def program_note(
    name: str, session: SessionState, registry: "MountRegistry"
) -> str | None:
    """What a program's ``/usr/bin`` file says about it, None when the
    name is no program.

    One line: what runs the name, and ``--help`` where the program's
    spec answers it, which a mount command's and a CLI's do; a builtin's
    answer varies (``ln --help`` and ``echo --help`` print no help), so
    a builtin's line names none.

    Args:
        name (str): the command word.
        session (SessionState): shell session (function table, allow
            list).
        registry (MountRegistry): mount registry (command registration,
            runtimes).
    """
    consumer = program(name, session, registry)
    if consumer is None:
        return None
    runtime = registry.runtime_bindings.get(name)
    if runtime is not None and (
        consumer is Consumer.EXTERNAL or name in INTERPRETER_NAMES
    ):
        return f"{name} runs on the workspace's {runtime.name} runtime."
    help_line = f" Help: {shell_quote(name)} --help"
    if consumer is Consumer.CLI:
        return f"{name} is a CLI registered with this workspace.{help_line}"
    runs = runs_as(name, registry)
    mount = (
        registry.mount_for_command(runs)
        if consumer is Consumer.MOUNT
        else None
    )
    spec = mount.spec_for(runs) if mount is not None else None
    if spec is not None and any(
        "--help" in o.names for o in compile_spec(spec).options
    ):
        return f"{name} is built into mirage.{help_line}"
    return f"{name} is built into mirage."


def runs_as(name: str, registry: "MountRegistry") -> str:
    """The program a command word runs: a wrapper no mount registers
    (``egrep``) runs the program it names, any other word itself.

    Args:
        name (str): the command word.
        registry (MountRegistry): mount registry (command registration).
    """
    if name in EXEC_WRAPPERS and registry.mount_for_command(name) is None:
        return EXEC_WRAPPERS[name][0]
    return name


def programs(session: SessionState, registry: "MountRegistry") -> list[str]:
    """Every program name the session can run, sorted: the ``/usr/bin``
    listing.

    The names are gathered from each layer that can hold a program and
    kept only where ``program`` says the name runs as one, so the
    listing and a lookup never disagree. A name only the external
    fallback capture would take cannot be listed, since that capture
    takes any word.

    Args:
        session (SessionState): shell session (function table, allow
            list).
        registry (MountRegistry): mount registry (command registration).
    """
    names = set(SHELL_NAMES) | NAMESPACE_COMMANDS | set(registry.clis.names())
    names |= ROUTED_COMMANDS | set(EXEC_WRAPPERS) | RUNNERS
    names |= {n for n in registry.runtime_bindings if n != EXTERNAL_COMMANDS}
    for mount in registry.mounts():
        names |= {cmd.name.split()[0] for cmd in mount.all_commands()}
    return sorted(
        n for n in names if program(n, session, registry) is not None
    )
