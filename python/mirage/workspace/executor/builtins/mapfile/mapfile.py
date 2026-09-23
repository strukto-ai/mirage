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

import re
from collections.abc import Callable
from typing import Any

from mirage.commands.spec.shell import SHELL_SPECS, parse_shell_options
from mirage.io import IOResult
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.stream import async_chain, materialize
from mirage.io.types import ByteSource
from mirage.ops.types import SessionView
from mirage.policy import PolicyDenied
from mirage.shell.array import ShellArray, array_set
from mirage.utils.quote import single_quote
from mirage.workspace.executor.builtins.shared import fail, require_view
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.session import SessionState
from mirage.workspace.session.state import (session_view, visible_arrays,
                                            visible_assocs)
from mirage.workspace.types import ExecutionNode

_USAGE = ("mapfile: usage: mapfile [-d delim] [-n count] [-O origin] "
          "[-s count] [-t] [-u fd] [-C callback] [-c quantum] [array]")
_IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_DEFAULT_QUANTUM = 5000


def _count(text: str) -> int | None:
    """A non-negative integer option value, else None.

    Args:
        text (str): the value as typed.
    """
    return int(text) if text.isdigit() else None


async def handle_mapfile(
    args: list[str],
    session: SessionState,
    stdin: ByteSource | None,
    execute_fn: Callable[..., Any],
    state: SessionView | None = None,
    cmd: str = "mapfile",
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Read input into an indexed array, one element per line.

    bash's surface, pinned on 5.2.37: `-d C` splits on `C` instead of
    newline (empty `C` is NUL), `-t` strips the delimiter from each
    element (kept otherwise, and a last record with no delimiter is
    stored as it came), `-n N` stops after N records (0 for all), `-O I`
    starts storing at index I and leaves the array's other elements
    alone (without it the array is emptied first), `-s N` skips the
    first N records, `-C CB` with `-c Q` evaluates `CB INDEX ELEMENT`
    after every Q-th element stored (Q defaults to 5000). `-u 0` is the
    input this shell has and any other descriptor is refused as bash
    refuses one it never opened. The array is `MAPFILE` when no name is
    given; a scalar of that name becomes an array, an associative one is
    refused, and only the first name is read.

    Args:
        args (list[str]): the words after the builtin.
        session (SessionState): shell session state.
        stdin (ByteSource | None): the input source.
        execute_fn (Callable): the executor's nested eval, for `-C`.
        state (SessionView | None): the session plane's gated door.
        cmd (str): `mapfile` or `readarray`, for diagnostics.
    """
    parse = parse_shell_options(SHELL_SPECS["mapfile"], args)
    if parse.invalid is not None:
        token = (parse.invalid
                 if parse.invalid.startswith("--") else f"-{parse.invalid}")
        return fail(cmd, f"bash: {cmd}: {token}: invalid option\n{_USAGE}\n",
                    2)
    if parse.needs_value is not None:
        return fail(
            cmd, f"bash: {cmd}: -{parse.needs_value}: option requires an "
            f"argument\n{_USAGE}\n", 2)
    flags = parse.flags
    delim = b"\n"
    if "d" in flags:
        text = str(flags["d"])
        delim = text[:1].encode() if text else b"\0"
    limit = 0
    origin = 0
    skip = 0
    quantum = _DEFAULT_QUANTUM
    for key, label, target in (("n", "line count",
                                "limit"), ("O", "array origin", "origin"),
                               ("s", "line count",
                                "skip"), ("c", "callback quantum", "quantum")):
        if key not in flags:
            continue
        value = _count(str(flags[key]))
        if value is None or (key == "c" and value == 0):
            return fail(cmd, f"bash: {cmd}: {flags[key]}: invalid {label}\n",
                        1)
        if target == "limit":
            limit = value
        elif target == "origin":
            origin = value
        elif target == "skip":
            skip = value
        else:
            quantum = value
    if "u" in flags and str(flags["u"]) != "0":
        return fail(
            cmd, f"bash: {cmd}: {flags['u']}: invalid file descriptor: "
            "Bad file descriptor\n", 1)
    strip = bool(flags.get("t"))
    callback = str(flags["C"]) if "C" in flags else None
    name = parse.operands[0] if parse.operands else "MAPFILE"
    if _IDENTIFIER.fullmatch(name) is None:
        return fail(cmd, f"bash: {cmd}: `{name}': not a valid identifier\n", 1)
    view = require_view(state)
    if view.is_readonly(name):
        return fail(cmd, f"bash: {name}: readonly variable\n", 1)
    if name in visible_assocs(session):
        return fail(cmd, f"bash: {cmd}: {name}: not an indexed array\n", 1)

    if stdin is not None and (session._stdin_buffer is None
                              or session._stdin_source is not stdin):
        if isinstance(stdin, bytes):
            session._stdin_buffer = AsyncLineIterator(async_chain(stdin))
            session._stdin_source = stdin
        elif hasattr(stdin, "__aiter__"):
            session._stdin_buffer = AsyncLineIterator(stdin)
            session._stdin_source = stdin
    buffer = session._stdin_buffer

    existing = visible_arrays(session).get(name)
    arr: ShellArray = (list(existing)
                       if existing is not None and "O" in flags else [])
    index = origin
    stored = 0
    seen = 0
    outputs: list[bytes] = []
    errors: list[bytes] = []
    while buffer is not None and (limit == 0 or stored < limit):
        data, found = await buffer.read_until(delim)
        if not found and not data:
            break
        seen += 1
        if seen <= skip:
            continue
        text = data.decode(errors="replace")
        if found and not strip:
            text += delim.decode(errors="replace")
        array_set(arr, index, text)
        stored += 1
        if callback is not None and stored % quantum == 0:
            # The record is data, not source: bash builds the callback
            # line with `sh_single_quote`, so a record reading `x; rm f`
            # arrives as one argument rather than running a second
            # command.
            io = await execute_fn(f"{callback} {index} {single_quote(text)}",
                                  session_id=session.session_id)
            out = await materialize(io.stdout)
            if out:
                outputs.append(out)
            err = await materialize(io.stderr)
            if err:
                errors.append(err)
        index += 1
        if not found:
            break
    try:
        await view.set(name, arr)
    except PolicyDenied as exc:
        return fail(cmd, f"{exc.strerror}\n", 1)
    stdout = b"".join(outputs) or None
    stderr = b"".join(errors) or None
    return stdout, IOResult(stderr=stderr), ExecutionNode(command=cmd,
                                                          exit_code=0)


async def mapfile_builtin(call: BuiltinCall) -> Result:
    """The ``mapfile`` / ``readarray`` arm.

    Args:
        call (BuiltinCall): the invocation; the head word is what the
            diagnostics name.
    """
    return await handle_mapfile(list(call.argv.args),
                                call.session,
                                call.stdin,
                                call.execute_fn,
                                session_view(call.session,
                                             call.namespace.registry.policies),
                                cmd=str(call.argv.name))
