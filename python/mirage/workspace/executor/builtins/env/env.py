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
from collections.abc import Callable
from typing import Any

from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.workspace.executor.builtins.env.constants import ENV_HELP_HINT
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.session import Session
from mirage.workspace.session.session import vars_from_env
from mirage.workspace.session.state import env_snapshot
from mirage.workspace.types import ExecutionNode


def _env_error(message: str) -> tuple[None, IOResult, ExecutionNode]:
    err = (message + "\n" + ENV_HELP_HINT).encode()
    return None, IOResult(exit_code=125,
                          stderr=err), ExecutionNode(command="env",
                                                     exit_code=125,
                                                     stderr=err)


async def handle_env(
    execute_fn: Callable[..., Any],
    args: list[str],
    session: Session,
    stdin: ByteSource | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run the ``env`` builtin (print environment or run a command).

    Usage: ``env [-i] [-u NAME]... [NAME=VALUE]... [command [arg]...]``.
    With no command it prints the (optionally modified) environment in
    ``environ`` order, unsorted, terminated per entry by newline or NUL
    (``-0``). With a command it runs it under the modified environment,
    forwarding stdin, then restores the session environment. Missing
    commands fail like GNU with the shell's own exit 127.

    Args:
        execute_fn (Callable): shell evaluator for the inner command.
        args (list[str]): words after the ``env`` name.
        session (Session): shell session state.
        stdin (ByteSource | None): piped input forwarded to the command.
    """
    ignore_env = False
    null = False
    unset: list[str] = []
    i = 0
    while i < len(args):
        tok = args[i]
        if tok == "--":
            i += 1
            break
        if tok in ("-i", "--ignore-environment"):
            ignore_env = True
            i += 1
            continue
        if tok in ("-0", "--null"):
            null = True
            i += 1
            continue
        if tok == "-":
            # GNU: "a mere - implies -i".
            ignore_env = True
            i += 1
            continue
        if tok == "--unset":
            if i + 1 >= len(args):
                return _env_error("env: option '--unset' requires an argument")
            unset.append(args[i + 1])
            i += 2
            continue
        if tok.startswith("--unset="):
            unset.append(tok[len("--unset="):])
            i += 1
            continue
        if tok.startswith("--"):
            return _env_error(f"env: unrecognized option '{tok}'")
        if tok.startswith("-") and len(tok) > 1:
            j = 1
            consumed_next = False
            while j < len(tok):
                ch = tok[j]
                if ch == "i":
                    ignore_env = True
                elif ch == "0":
                    null = True
                elif ch == "u":
                    rest = tok[j + 1:]
                    if rest:
                        unset.append(rest)
                    elif i + 1 < len(args):
                        unset.append(args[i + 1])
                        consumed_next = True
                    else:
                        return _env_error(
                            "env: option requires an argument -- 'u'")
                    break
                else:
                    return _env_error(f"env: invalid option -- '{ch}'")
                j += 1
            i += 2 if consumed_next else 1
            continue
        break

    base = {} if ignore_env else env_snapshot(session)
    for name in unset:
        base.pop(name, None)
    while i < len(args) and "=" in args[i] and not args[i].startswith("="):
        key, _, value = args[i].partition("=")
        base[key] = value
        i += 1

    command = args[i:]
    if command and null:
        return _env_error("env: cannot specify --null (-0) with command")
    if not command:
        sep = "\0" if null else "\n"
        out = "".join(f"{k}={v}{sep}" for k, v in base.items()).encode()
        return out, IOResult(), ExecutionNode(command="env", exit_code=0)

    # `env NAME=v cmd` runs the command with a replaced environment.
    # Only the scalars are replaced: arrays were never part of the env
    # the old two-container store swapped, and bash does not put one in
    # a child's environment either. A still-unfetched managed entry is
    # a scalar in waiting, so it is replaced too: surviving the swap
    # would let the inner line fetch and read a name `-i` or `-u` just
    # cleared.
    saved = session.vars
    session.vars = {
        name: var
        for name, var in saved.items()
        if not isinstance(var.value, str) and var.managed is None
    } | vars_from_env(base)
    try:
        io = await execute_fn(shlex.join(command),
                              session_id=session.session_id,
                              stdin=stdin)
    finally:
        session.vars = saved
    return io.stdout, io, ExecutionNode(command="env", exit_code=io.exit_code)


async def env_builtin(call: BuiltinCall) -> Result:
    """The ``env`` arm.

    Args:
        call (BuiltinCall): the invocation.
    """
    return await handle_env(call.execute_fn, list(call.argv.args),
                            call.session, call.stdin)
