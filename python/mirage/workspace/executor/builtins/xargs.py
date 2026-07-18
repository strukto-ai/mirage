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

from mirage.commands.spec.shell import SHELL_SPECS, parse_shell_options
from mirage.io import IOResult
from mirage.io.stream import async_chain, materialize
from mirage.io.types import ByteSource
from mirage.workspace.session import Session
from mirage.workspace.types import ExecutionNode

_UNSUPPORTED = ("I", "P")


def _usage_error(message: str) -> tuple[None, IOResult, ExecutionNode]:
    stderr = f"xargs: {message}\n".encode()
    return None, IOResult(exit_code=1,
                          stderr=stderr), ExecutionNode(command="xargs",
                                                        exit_code=1)


def _split_items(data: bytes, flags: dict[str, str | bool]) -> list[str]:
    if flags.get("0") is True:
        return [
            chunk.decode(errors="replace") for chunk in data.split(b"\0")
            if chunk
        ]
    delim = flags.get("d")
    if isinstance(delim, str):
        delim = delim.replace("\\n", "\n").replace("\\t", "\t")
        text = data.decode(errors="replace")
        if text.endswith(delim):
            text = text[:-len(delim)]
        return text.split(delim) if text else []
    return data.decode(errors="replace").split()


async def handle_xargs(
    execute_fn: Callable[..., Any],
    args: list[str],
    session: Session,
    stdin: ByteSource | None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run a command with words read from stdin appended (GNU xargs).

    GNU xargs execs the command directly, so every input word must
    reach it as exactly one argv token. The inner line is built with
    shlex.join: a plain join would be re-parsed by the shell, splitting
    words with whitespace and executing $(...) found in input.

    Args:
        execute_fn (Callable): shell evaluator for the inner line.
        args (list[str]): options, then command name and initial
            arguments; the command defaults to ["echo"] like GNU.
        session (Session): shell session state.
        stdin (ByteSource | None): input whose words become arguments.
    """
    parse = parse_shell_options(SHELL_SPECS["xargs"], args or [])
    if parse.invalid is not None:
        if parse.invalid.startswith("--"):
            return _usage_error(f"unrecognized option '{parse.invalid}'")
        return _usage_error(f"invalid option -- '{parse.invalid}'")
    if parse.needs_value is not None:
        return _usage_error(
            f"option requires an argument -- '{parse.needs_value}'")
    for name in _UNSUPPORTED:
        if name in parse.flags:
            return _usage_error(f"unsupported option -- '{name}'")
    max_args: int | None = None
    raw_n = parse.flags.get("n")
    if isinstance(raw_n, str):
        if not raw_n.isdigit():
            return _usage_error(f'invalid number "{raw_n}" for -n option')
        max_args = int(raw_n)
        if max_args < 1:
            return _usage_error(f"value {raw_n} for -n option should be >= 1")

    data = await materialize(stdin)
    if data is None:
        data = b""
    items = _split_items(data, parse.flags)
    if not items and parse.flags.get("r") is True:
        return None, IOResult(), ExecutionNode(command="xargs", exit_code=0)

    command = parse.operands or ["echo"]
    if max_args is None:
        batches = [items]
    else:
        batches = [
            items[i:i + max_args] for i in range(0, len(items), max_args)
        ] or [[]]

    stdouts: list[ByteSource] = []
    merged = IOResult()
    exit_code = 0
    for batch in batches:
        inner = shlex.join([*command, *batch])
        io = await execute_fn(inner, session_id=session.session_id)
        if io.stdout is not None:
            stdouts.append(io.stdout)
        merged = await merged.merge(io)
        if io.exit_code in (126, 127):
            # GNU xargs stops when the command cannot run or is missing.
            exit_code = io.exit_code
            break
        if io.exit_code != 0:
            # GNU exits 123 when any invocation fails, but keeps going.
            exit_code = 123
    merged.exit_code = exit_code
    out = async_chain(*stdouts) if stdouts else None
    return out, merged, ExecutionNode(command="xargs", exit_code=exit_code)
