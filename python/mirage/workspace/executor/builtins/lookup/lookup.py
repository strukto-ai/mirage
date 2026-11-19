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

from collections.abc import Mapping

from mirage.shell.bytes import encode_text
from mirage.shell.voice import shell_voice
from mirage.workspace.executor.builtins.alias.alias import aliases_on
from mirage.workspace.executor.builtins.getopt import (
    OptionScan,
    last_of,
    scan_options,
)
from mirage.workspace.executor.builtins.lookup.classify import (
    describe,
    locations,
    program_file,
)
from mirage.workspace.executor.builtins.lookup.constants import (
    TYPE_OPTIONS,
    WHICH_OPTIONS,
    WHICH_USAGE,
)
from mirage.workspace.executor.builtins.lookup.types import NameKind
from mirage.workspace.executor.builtins.shared import (
    builtin_usage,
    result,
    written,
)
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.lookup import program
from mirage.workspace.lookup.constants import PROGRAM_LOOKUPS
from mirage.workspace.lookup.machine import machine_answers
from mirage.workspace.lookup.types import MachineAnswer
from mirage.workspace.mount import MountRegistry
from mirage.workspace.session import SessionState


async def asked_machines(
    call: BuiltinCall,
    scan: OptionScan,
    option: str,
    past_functions: bool,
) -> dict[str, MachineAnswer]:
    """What the machines that run a lookup's names answered it, by name:
    the lookup builtin hands these to its renderer, which prints a
    machine's answer where Mirage holds no layer of the name it reports
    (``ProgramLookup`` has the rule). An alias the line would expand is
    Mirage's to report, unless the lookup looks past it.

    Args:
        call (BuiltinCall): the lookup's invocation.
        scan (OptionScan): its options and operands, a valid scan.
        option (str): the option whose ``PROGRAM_LOOKUPS`` row it is,
            "" for none.
        past_functions (bool): it finds the program a function or alias
            of the same name shadows (``which``, ``type -P``, ``-a``).
    """
    session = call.context.session
    names = [
        name
        for name in scan.operands
        if past_functions
        or not (aliases_on(session) and name in session.aliases)
    ]
    if not names:
        return {}
    command = call.argv.name
    return await machine_answers(
        command,
        "".join(scan.letters),
        names,
        PROGRAM_LOOKUPS[command, option],
        past_functions,
        session,
        call.registry,
        call.namespace.session_links(session),
        call.context.frame.routing,
    )


def handle_type(
    args: list[str],
    session: SessionState,
    registry: MountRegistry,
    answers: Mapping[str, MachineAnswer] | None = None,
) -> Result:
    """Run the ``type`` builtin (``type [-afptP] name [name ...]``).

    Resolution matches ``command -V``, but the exit rule is ``type``'s:
    0 only when every name resolves. ``-t`` prints the classification
    word; ``-p`` prints the file of a name that resolves to one (none
    for a builtin, which still resolves) and ``-P`` searches PATH for
    one even past a builtin, a miss there being a miss; the three are
    one group, the last winning. ``-a`` prints one line per layer
    holding the name (a builtin that is also a program ends with its
    file's line), ``-f`` ignores the function table, and a missing name
    warns on stderr unless a word-only mode (``-t``/``-p``/``-P``) is
    active. Pinned against bash 5.2 on debian:stable-slim.

    A name a machine runs (``asked_machines``) is reported by the
    machine's own ``type`` wherever Mirage holds no layer of it to report
    first: Mirage's function, alias or builtin lines come ahead of the
    machine's file lines under ``-a``.

    Args:
        args (list[str]): words after the ``type`` name.
        session (SessionState): shell session (function table).
        registry (MountRegistry): mount registry for name resolution.
        answers (Mapping[str, MachineAnswer] | None): what the machine
            that runs each name answered, by name; None for none.
    """
    scan = scan_options(args, TYPE_OPTIONS)
    if scan.bad is not None:
        return result(
            "type",
            exit_code=2,
            stderr=f"{shell_voice()}type: {scan.bad}: invalid option\n"
            f"{builtin_usage('type')}",
        )
    mode = last_of(scan.letters, "tpP")
    all_mode = "a" in scan.letters
    hidden = NameKind.FUNCTION if "f" in scan.letters else None
    pieces: list[tuple[bool, str]] = []
    all_found = True
    asked = answers or {}
    for name in scan.operands:
        answer = asked.get(name)
        if mode == "P":
            if answer is not None:
                all_found = all_found and answer.found
                pieces.extend((False, f"{line}\n") for line in answer.lines)
            elif program(name, session, registry) is None:
                all_found = False
            else:
                pieces.append((False, f"{program_file(name)}\n"))
            continue
        kinds = locations(name, session, registry, all_mode, hidden)
        machine: tuple[str, ...] = ()
        if answer is not None:
            kinds = [kind for kind in kinds if kind is not NameKind.FILE]
            if (all_mode or not kinds) and answer.found:
                machine = answer.lines
        if not kinds and not machine:
            all_found = False
            if mode is None:
                pieces.append(
                    (True, f"{shell_voice()}type: {name}: not found\n")
                )
            continue
        if mode == "t":
            pieces.extend((False, f"{kind.value}\n") for kind in kinds)
        elif mode == "p":
            pieces.extend(
                (False, f"{program_file(name)}\n")
                for kind in kinds
                if kind is NameKind.FILE
            )
        else:
            pieces.extend(
                (False, f"{describe(name, kind, session)}\n") for kind in kinds
            )
        pieces.extend((False, f"{line}\n") for line in machine)
    # One call, so the diagnostics never ride on the status: a partial
    # miss both warns and reports through the exit code.
    code = 0 if (not scan.operands or all_found) else 1
    return written("type", pieces, code)


def handle_which(
    args: list[str],
    session: SessionState,
    registry: MountRegistry,
    answers: Mapping[str, MachineAnswer] | None = None,
) -> Result:
    """Run the ``which`` builtin (``which [-as] name [name ...]``).

    Pinned against debianutils ``which`` (debian:stable-slim): it prints
    the file PATH finds for each name, which is the program's under
    ``/usr/bin`` (the one PATH directory), a miss prints nothing at all,
    the exit status is 0 only when every name resolves (1 with no
    operands), and ``-s`` reports through the status alone. A builtin
    with no program (``cd``), a function, an alias and a reserved word
    are no file, so each is a miss; ``-a`` has one directory to search
    and so one line per name. ``$PATH`` itself is not read: mirage runs
    a program by its name whatever PATH holds, so ``which`` answers as
    dispatch does. The refusal for an unknown option is bash's shape,
    not the C tool's ``Illegal option``, because this is a builtin.

    A name a machine runs (``asked_machines``) is the machine's own
    ``which`` to answer, as Mirage asked it.

    Args:
        args (list[str]): words after the ``which`` name.
        session (SessionState): shell session (function table).
        registry (MountRegistry): mount registry for name resolution.
        answers (Mapping[str, MachineAnswer] | None): what the machine
            that runs each name answered, by name; None for none.
    """
    scan = scan_options(args, WHICH_OPTIONS)
    if scan.bad is not None:
        return result(
            "which",
            exit_code=2,
            stderr=f"which: {scan.bad}: invalid option\n{WHICH_USAGE}",
        )
    silent = "s" in scan.letters
    out_lines: list[str] = []
    all_found = True
    asked = answers or {}
    for name in scan.operands:
        answer = asked.get(name)
        if answer is not None:
            all_found = all_found and answer.found
            if not silent:
                out_lines.extend(f"{line}\n" for line in answer.lines)
            continue
        if program(name, session, registry) is None:
            all_found = False
            continue
        if not silent:
            out_lines.append(f"{program_file(name)}\n")
    out = encode_text("".join(out_lines)) if out_lines else None
    code = 0 if (scan.operands and all_found) else 1
    return result("which", out=out, exit_code=code)


async def type_builtin(call: BuiltinCall) -> Result:
    """The ``type`` arm: the machines that run its names are asked
    first, then ``handle_type`` reports.

    Args:
        call (BuiltinCall): the invocation.
    """
    args = list(call.argv.args)
    scan = scan_options(args, TYPE_OPTIONS)
    answers: dict[str, MachineAnswer] = {}
    if scan.bad is None:
        mode = last_of(scan.letters, "tpP")
        every = "a" in scan.letters
        option = f"-{mode}" if mode else ("-a" if every else "")
        answers = await asked_machines(
            call, scan, option, mode == "P" or every
        )
    return handle_type(args, call.context.session, call.registry, answers)


async def which_builtin(call: BuiltinCall) -> Result:
    """The ``which`` arm: the machines that run its names are asked
    first, then ``handle_which`` reports.

    Args:
        call (BuiltinCall): the invocation.
    """
    args = list(call.argv.args)
    scan = scan_options(args, WHICH_OPTIONS)
    answers: dict[str, MachineAnswer] = {}
    if scan.bad is None:
        answers = await asked_machines(call, scan, "", True)
    return handle_which(args, call.context.session, call.registry, answers)
