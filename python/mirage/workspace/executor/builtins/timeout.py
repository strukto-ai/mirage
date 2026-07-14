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
import re
import shlex
from collections.abc import Callable

from mirage.commands.spec.shell import SHELL_SPECS, parse_shell_options
from mirage.io import IOResult
from mirage.io.stream import materialize
from mirage.io.types import ByteSource
from mirage.workspace.session import Session
from mirage.workspace.types import ExecutionNode

_DURATION = re.compile(r"(\d+(?:\.\d*)?|\.\d+)([smhd]?)")

_UNIT_SECONDS = {"": 1.0, "s": 1.0, "m": 60.0, "h": 3600.0, "d": 86400.0}

_UNSUPPORTED = ("s", "k", "preserve-status")


def _usage_error(message: str) -> tuple[None, IOResult, ExecutionNode]:
    # GNU timeout reserves 125 for its own failures; 124 means the
    # command was killed at the deadline.
    stderr = f"timeout: {message}\n".encode()
    return None, IOResult(exit_code=125,
                          stderr=stderr), ExecutionNode(command="timeout",
                                                        exit_code=125)


def parse_duration(raw: str) -> float | None:
    """Parse a GNU timeout duration (float plus optional s/m/h/d).

    Args:
        raw (str): duration operand as typed.
    """
    match = _DURATION.fullmatch(raw)
    if match is None:
        return None
    return float(match.group(1)) * _UNIT_SECONDS[match.group(2)]


async def handle_timeout(
    execute_fn: Callable,
    args: list[str],
    session: Session,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run `timeout DURATION COMMAND [ARG...]`, killing at the deadline.

    The inner line is built with shlex.join so already-expanded words
    survive re-parsing as one token each (GNU timeout execs the command
    without a shell). On overrun the inner run is cancelled and the
    exit code is 124 like GNU. Signal options (-s, -k,
    --preserve-status) are parsed but rejected: the inner run is a
    coroutine, not a process, so there is nothing to signal.

    Args:
        execute_fn (Callable): shell evaluator for the inner line.
        args (list[str]): options, duration operand, then the command.
        session (Session): shell session state.
    """
    parse = parse_shell_options(SHELL_SPECS["timeout"], args or [])
    if parse.invalid is not None:
        if parse.invalid.startswith("--"):
            return _usage_error(f"unrecognized option '{parse.invalid}'")
        return _usage_error(f"invalid option -- '{parse.invalid}'")
    if parse.needs_value is not None:
        return _usage_error(
            f"option requires an argument -- '{parse.needs_value}'")
    for name in _UNSUPPORTED:
        if name in parse.flags:
            dashes = "--" if len(name) > 1 else "-"
            return _usage_error(f"unsupported option -- '{dashes}{name}'")
    if len(parse.operands) < 2:
        return _usage_error("missing operand")
    raw = parse.operands[0]
    seconds = parse_duration(raw)
    if seconds is None:
        return _usage_error(f"invalid time interval '{raw}'")

    inner = shlex.join(parse.operands[1:])
    try:
        stdout, io = await asyncio.wait_for(
            _execute_drained(execute_fn, inner, session.session_id),
            timeout=seconds if seconds > 0 else None,
        )
    except asyncio.TimeoutError:
        return None, IOResult(exit_code=124), ExecutionNode(command="timeout",
                                                            exit_code=124)
    return stdout, io, ExecutionNode(command="timeout", exit_code=io.exit_code)


async def _execute_drained(
    execute_fn: Callable,
    inner: str,
    session_id: str,
) -> tuple[bytes | None, IOResult]:
    """Run the inner line and drain its stdout under the same deadline.

    A lazy inner pipeline produces bytes only when consumed; draining
    inside the wait_for scope keeps the whole run under the limit.

    Args:
        execute_fn (Callable): shell evaluator for the inner line.
        inner (str): the joined command line.
        session_id (str): session to run in.
    """
    io = await execute_fn(inner, session_id=session_id)
    stdout = await materialize(io.stdout)
    return stdout, io
