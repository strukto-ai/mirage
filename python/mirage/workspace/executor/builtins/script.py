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
import math
import re
from collections.abc import Callable
from typing import Any

from mirage.io import IOResult
from mirage.io.stream import materialize
from mirage.io.types import ByteSource
from mirage.types import PathSpec
from mirage.utils.path import resolve_path
from mirage.workspace.abort import cancellable_sleep
from mirage.workspace.executor.builtins.scope import _scope_path, _to_scope
from mirage.workspace.session import Session
from mirage.workspace.types import ExecutionNode


async def handle_source(
    dispatch: Callable[..., Any],
    execute_fn: Callable[..., Any],
    path: str | PathSpec,
    session: Session,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Read a script file and execute it."""
    raw = _scope_path(path)
    resolved = resolve_path(raw, session.cwd)
    scope = _to_scope(resolved)
    data, _ = await dispatch("read", scope)
    if isinstance(data, bytes):
        script = data.decode(errors="replace")
    else:
        script = ""
    io = await execute_fn(script, session_id=session.session_id)
    return io.stdout, io, ExecutionNode(command=f"source {raw}",
                                        exit_code=io.exit_code)


async def handle_eval(
    execute_fn: Callable[..., Any],
    args: list[str],
    session: Session,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    script = " ".join(args)
    io = await execute_fn(script, session_id=session.session_id)
    return io.stdout, io, ExecutionNode(command="eval", exit_code=io.exit_code)


_BASH_NOOP_SHORT_FLAGS = frozenset({"l", "i", "e", "u", "x"})

_BASH_NOOP_LONG_FLAGS = frozenset(
    {"--login", "--norc", "--noprofile", "--posix", "--rcfile"})


async def handle_bash(
    execute_fn: Callable[..., Any],
    args: list[str],
    session: Session,
    stdin: ByteSource | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    script: str | None = None
    read_stdin = False
    i = 0
    while i < len(args):
        tok = args[i]
        if tok == "--":
            i += 1
            break
        if tok == "-c":
            if i + 1 >= len(args):
                err = b"bash: -c: option requires an argument\n"
                return None, IOResult(exit_code=2, stderr=err), ExecutionNode(
                    command="bash", exit_code=2, stderr=err)
            script = args[i + 1]
            break
        if tok == "-s":
            read_stdin = True
            i += 1
            continue
        if tok in ("-o", "+o"):
            i += 2
            continue
        if tok in _BASH_NOOP_LONG_FLAGS:
            i += 1
            continue
        if (tok.startswith("-") and len(tok) > 1 and not tok.startswith("--")):
            chars = tok[1:]
            if "c" in chars:
                if i + 1 >= len(args):
                    err = b"bash: -c: option requires an argument\n"
                    return None, IOResult(
                        exit_code=2, stderr=err), ExecutionNode(command="bash",
                                                                exit_code=2,
                                                                stderr=err)
                script = args[i + 1]
                break
            if all(ch in _BASH_NOOP_SHORT_FLAGS or ch == "s" for ch in chars):
                if "s" in chars:
                    read_stdin = True
                i += 1
                continue
            err = (f"bash: {tok}: unsupported option\n").encode()
            return None, IOResult(exit_code=2,
                                  stderr=err), ExecutionNode(command="bash",
                                                             exit_code=2,
                                                             stderr=err)
        if script is None:
            script = tok
            break
        i += 1
    if script is None and read_stdin and stdin is not None:
        stdin_data = await materialize(stdin)
        if stdin_data:
            script = stdin_data.decode(errors="replace")
            stdin = None
    if script is None:
        return None, IOResult(), ExecutionNode(command="bash", exit_code=0)
    io = await execute_fn(script, session_id=session.session_id, stdin=stdin)
    return io.stdout, io, ExecutionNode(command=f"bash -c {script}",
                                        exit_code=io.exit_code)


# Finite non-negative decimals only ("0", "0.2", ".5", "1.", "+1", "1e-3").
# GNU sleep additionally accepts "inf" and sleeps forever; an agent shell
# must never hang, so non-finite intervals are rejected (deliberate
# divergence). The regex also keeps Python/TypeScript parsing identical:
# float() alone would accept "inf", "nan", "1_0", and surrounding whitespace
# that Number() rejects, and Number() accepts hex that float() rejects.
SLEEP_INTERVAL = re.compile(r"\+?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?")


async def handle_sleep(
    args: list[str],
    cancel: asyncio.Event | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    if not args:
        err = b"sleep: missing operand\n"
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command="sleep",
                                                         exit_code=1)
    raw = args[0]
    # "1e309" passes the regex but overflows to inf, so check both.
    seconds = float(raw) if SLEEP_INTERVAL.fullmatch(raw) else math.inf
    if not math.isfinite(seconds):
        err = f"sleep: invalid time interval '{raw}'\n".encode()
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command="sleep",
                                                         exit_code=1)
    await cancellable_sleep(seconds, cancel)
    return None, IOResult(), ExecutionNode(command="sleep", exit_code=0)
