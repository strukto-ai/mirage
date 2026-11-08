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

from collections.abc import Callable, Sequence
from typing import Any

from mirage.io.types import ByteSource
from mirage.shell.call_stack import CallStack
from mirage.shell.join import shell_join
from mirage.shell.voice import shell_voice
from mirage.utils.quote import single_quote
from mirage.workspace.executor.builtins.getopt import last_of, scan_options
from mirage.workspace.executor.builtins.lookup import (
    classify,
    describe,
    program_file,
)
from mirage.workspace.executor.builtins.lookup.types import NameKind
from mirage.workspace.executor.builtins.shared import (
    builtin_usage,
    ok,
    result,
    written,
)
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.lookup.constants import BASH_BUILTINS, SHELL_NAMES
from mirage.workspace.mount import MountRegistry
from mirage.workspace.session import SessionState
from mirage.workspace.types import ExecutionNode


def _probe(
    mode: str,
    rest: Sequence[str],
    session: SessionState,
    registry: MountRegistry,
) -> Result:
    """Run the ``-v``/``-V`` introspection modes.

    The exit status is 0 when no names are given, otherwise 0 if any name
    resolved and 1 if none did (bash's ``command`` uses this any-found
    rule, unlike ``type``'s all-found rule). ``-v`` prints a program's
    file and any other resolvable name bare (a builtin, a function);
    ``-V`` prints a verbose line.
    Not-found names are silent under ``-v`` and warn on stderr under ``-V``.

    Args:
        mode (str): ``"v"`` or ``"V"``.
        rest (Sequence[str]): operand words to classify.
        session (SessionState): shell session state.
        registry (MountRegistry): mount registry.
    """
    pieces: list[tuple[bool, str]] = []
    any_found = False
    for name in rest:
        kind = classify(name, session, registry)
        if kind is None:
            if mode == "V":
                pieces.append(
                    (True, f"{shell_voice()}command: {name}: not found\n")
                )
            continue
        any_found = True
        if mode == "V":
            line = describe(name, kind, session)
        elif kind is NameKind.ALIAS:
            # `command -v` prints an alias as its definition, the one
            # form that is not just the name.
            line = f"alias {name}={single_quote(session.aliases[name])}"
        elif kind is NameKind.FILE:
            line = program_file(name)
        else:
            line = name
        pieces.append((False, f"{line}\n"))
    # The status and the diagnostics are independent: bash prints
    # `command: nope: not found` for a missing name and still exits 0
    # when another name resolved.
    code = 0 if (not rest or any_found) else 1
    return written("command", pieces, code)


async def handle_command_builtin(
    execute_fn: Callable[..., Any],
    args: list[str],
    session: SessionState,
    registry: MountRegistry,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
) -> Result:
    """Run the ``command`` builtin (``command [-pVv] name [arg ...]``).

    Without ``-v``/``-V`` it runs the target ignoring any shell function
    of the same name (bash's function bypass): the name is masked in the
    session function table for the inner run so a shadowing function is
    skipped while builtins and mount commands still resolve. Already
    expanded operands are re-joined with ``shlex`` so they survive
    re-parsing as one token each. The target runs in the caller's
    frames, as a builtin does in bash: an ``exit`` in it ends the shell
    and a ``return`` the function. ``-p`` is accepted but inert (the
    default PATH is the one PATH there is) and the last of ``-v``/``-V``
    wins.

    Args:
        execute_fn (Callable): shell evaluator for the inner line.
        args (list[str]): words after the ``command`` name.
        session (SessionState): shell session state.
        registry (MountRegistry): mount registry for name resolution.
        stdin (ByteSource | None): piped input for the inner run.
        call_stack (CallStack | None): the caller's frames; None runs
            the target as a line of its own.
    """
    scan = scan_options(args, "pvV")
    if scan.bad is not None:
        return result(
            "command",
            exit_code=2,
            stderr=f"{shell_voice()}command: {scan.bad}: invalid option\n"
            + builtin_usage("command"),
        )
    mode = last_of(scan.letters, "vV")
    rest = scan.operands
    if mode is not None:
        return _probe(mode, rest, session, registry)
    if not rest:
        return ok("command")

    return await _past_functions(
        "command", execute_fn, rest, session, stdin, call_stack
    )


async def _past_functions(
    cmd: str,
    execute_fn: Callable[..., Any],
    words: Sequence[str],
    session: SessionState,
    stdin: ByteSource | None,
    call_stack: CallStack | None,
) -> Result:
    """Run ``words`` past a shell function or alias of their head's name.

    The line's head is single-quoted, which bash never expands as an
    alias or reads as a keyword, so the alias table stays whole for the
    builtin to read (``builtin alias alias``), and still reads as the
    literal word it is (``command bash -c`` is a nested shell). A shadowing function is
    masked in the session for the inner run while builtins and mount
    commands still resolve; a function never shadows a builtin, so one
    named like a builtin stays.

    Args:
        cmd (str): the builtin that runs them, named on the node.
        execute_fn (Callable): shell evaluator for the inner line.
        words (list[str]): the command and its arguments.
        session (SessionState): shell session state.
        stdin (ByteSource | None): piped input for the inner run.
        call_stack (CallStack | None): the caller's frames; None runs
            the target as a line of its own.
    """
    inner_name = words[0]
    rest = shell_join(words[1:])
    inner = single_quote(inner_name) + (f" {rest}" if rest else "")
    # A function never shadows a bash builtin mirage runs, so one of such
    # a name stays for the builtin to read or remove (`builtin unset -f
    # unset`); an interpreter's (`python3`) is still masked. Function
    # bodies are never None, so popping with a None default lets `is not
    # None` mean "a shadowing function was masked" for restore.
    saved_fn = (
        None
        if inner_name in BASH_BUILTINS and inner_name in SHELL_NAMES
        else session.functions.pop(inner_name, None)
    )
    try:
        io = await execute_fn(
            inner,
            session_id=session.session_id,
            stdin=stdin,
            call_stack=call_stack,
        )
    finally:
        if saved_fn is not None:
            session.functions[inner_name] = saved_fn
    return (
        io.stdout,
        io,
        ExecutionNode(command=cmd, exit_code=io.exit_code),
    )


async def handle_builtin(
    execute_fn: Callable[..., Any],
    args: list[str],
    session: SessionState,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
) -> Result:
    """Run the ``builtin`` builtin (``builtin [shell-builtin [arg ...]]``).

    It runs a shell builtin past a function or alias of its name, in the
    caller's frames as ``command`` does, and refuses any other word
    (``builtin: ls: not a shell builtin``, status 1); with no word it
    does nothing. ``--`` ends its options and any other one is refused
    with status 2. Pinned against bash 5.2 on debian:stable-slim.

    Args:
        execute_fn (Callable): shell evaluator for the inner line.
        args (list[str]): words after the ``builtin`` name.
        session (SessionState): shell session state.
        stdin (ByteSource | None): piped input for the inner run.
        call_stack (CallStack | None): the caller's frames; None runs
            the target as a line of its own.
    """
    if args[:1] == ["--"]:
        args = args[1:]
    elif args and args[0].startswith("-") and args[0] != "-":
        return result(
            "builtin",
            exit_code=2,
            stderr=f"{shell_voice()}builtin: {args[0]}: invalid option\n"
            + builtin_usage("builtin"),
        )
    if not args:
        return ok("builtin")
    if args[0] not in BASH_BUILTINS:
        return result(
            "builtin",
            exit_code=1,
            stderr=f"{shell_voice()}builtin: {args[0]}: not a shell builtin\n",
        )
    return await _past_functions(
        "builtin", execute_fn, args, session, stdin, call_stack
    )


async def builtin_builtin(call: BuiltinCall) -> Result:
    """The ``builtin`` arm.

    Args:
        call (BuiltinCall): the invocation.
    """
    return await handle_builtin(
        call.execute_fn,
        list(call.argv.args),
        call.context.session,
        call.stdin,
        call.call_stack,
    )


async def command_builtin(call: BuiltinCall) -> Result:
    """The ``command`` arm.

    Args:
        call (BuiltinCall): the invocation.
    """
    return await handle_command_builtin(
        call.execute_fn,
        list(call.argv.args),
        call.context.session,
        call.registry,
        call.stdin,
        call.call_stack,
    )
