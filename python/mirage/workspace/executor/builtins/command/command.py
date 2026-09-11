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

import shlex
from collections.abc import Callable, Sequence
from typing import Any

from mirage.io.types import ByteSource
from mirage.utils.quote import single_quote
from mirage.workspace.executor.builtins.getopt import last_of, scan_options
from mirage.workspace.executor.builtins.lookup import classify, describe
from mirage.workspace.executor.builtins.lookup.types import NameKind
from mirage.workspace.executor.builtins.shared import ok, result
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.mount import MountRegistry
from mirage.workspace.session import Session
from mirage.workspace.types import ExecutionNode

_USAGE = "command: usage: command [-pVv] command [arg ...]\n"
_OPTIONS = "pvV"


def _probe(mode: str, rest: Sequence[str], session: Session,
           registry: MountRegistry) -> Result:
    """Run the ``-v``/``-V`` introspection modes.

    The exit status is 0 when no names are given, otherwise 0 if any name
    resolved and 1 if none did (bash's ``command`` uses this any-found
    rule, unlike ``type``'s all-found rule). ``-v`` prints the name for a
    resolvable command (no fake path); ``-V`` prints a verbose line.
    Not-found names are silent under ``-v`` and warn on stderr under ``-V``.

    Args:
        mode (str): ``"v"`` or ``"V"``.
        rest (Sequence[str]): operand words to classify.
        session (Session): shell session state.
        registry (MountRegistry): mount registry.
    """
    out_lines: list[str] = []
    err_lines: list[str] = []
    any_found = False
    for name in rest:
        kind = classify(name, session, registry)
        if kind is None:
            if mode == "V":
                err_lines.append(f"command: {name}: not found\n")
            continue
        any_found = True
        if mode == "V":
            line = describe(name, kind, session)
        elif kind is NameKind.ALIAS:
            # `command -v` prints an alias as its definition, the one
            # form that is not just the name.
            line = f"alias {name}={single_quote(session.aliases[name])}"
        else:
            line = name
        out_lines.append(f"{line}\n")
    out = "".join(out_lines).encode() if out_lines else None
    # The status and the diagnostics are independent: bash prints
    # `command: nope: not found` for a missing name and still exits 0
    # when another name resolved.
    code = 0 if (not rest or any_found) else 1
    return result("command",
                  out=out,
                  exit_code=code,
                  stderr="".join(err_lines))


async def handle_command_builtin(
    execute_fn: Callable[..., Any],
    args: list[str],
    session: Session,
    registry: MountRegistry,
    stdin: ByteSource | None = None,
) -> Result:
    """Run the ``command`` builtin (``command [-pVv] name [arg ...]``).

    Without ``-v``/``-V`` it runs the target ignoring any shell function
    of the same name (bash's function bypass): the name is masked in the
    session function table for the inner run so a shadowing function is
    skipped while builtins and mount commands still resolve. Already
    expanded operands are re-joined with ``shlex`` so they survive
    re-parsing as one token each. ``-p`` is accepted but inert (mirage
    has no PATH) and the last of ``-v``/``-V`` wins.

    Args:
        execute_fn (Callable): shell evaluator for the inner line.
        args (list[str]): words after the ``command`` name.
        session (Session): shell session state.
        registry (MountRegistry): mount registry for name resolution.
        stdin (ByteSource | None): piped input for the inner run.
    """
    scan = scan_options(args, _OPTIONS)
    if scan.bad is not None:
        return result("command",
                      exit_code=2,
                      stderr=f"command: {scan.bad}: invalid option\n{_USAGE}")
    mode = last_of(scan.letters, "vV")
    rest = scan.operands
    if mode is not None:
        return _probe(mode, rest, session, registry)
    if not rest:
        return ok("command")

    inner_name = rest[0]
    inner = shlex.join(rest)
    # Function bodies are never None, so popping with a None default lets
    # `is not None` mean "a shadowing function was masked" for restore.
    # An alias is masked the same way: bash expands an alias only as a
    # command's first word, which `command` is, so `command cat` runs
    # the program past `alias cat=...` too.
    saved_fn = session.functions.pop(inner_name, None)
    saved_alias = session.aliases.pop(inner_name, None)
    try:
        io = await execute_fn(inner,
                              session_id=session.session_id,
                              stdin=stdin)
    finally:
        if saved_fn is not None:
            session.functions[inner_name] = saved_fn
        if saved_alias is not None:
            session.aliases[inner_name] = saved_alias
    return io.stdout, io, ExecutionNode(command="command",
                                        exit_code=io.exit_code)


async def command_builtin(call: BuiltinCall) -> Result:
    """The ``command`` arm.

    Args:
        call (BuiltinCall): the invocation.
    """
    return await handle_command_builtin(call.execute_fn, list(call.argv.args),
                                        call.session, call.registry,
                                        call.stdin)
