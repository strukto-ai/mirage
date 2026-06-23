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

from mirage.io import IOResult
from mirage.workspace.executor.aggregate import run_aggregate
from mirage.workspace.executor.cross.adapter import build_dispatch_io
from mirage.workspace.executor.cross.detect import (MULTI_READ_COMMANDS,
                                                    TRANSFER_COMMANDS)
from mirage.workspace.executor.cross.types import CrossResult, Dispatch
from mirage.workspace.executor.transfer import run_transfer
from mirage.workspace.types import ExecutionNode


async def handle_cross_mount(
    cmd_name: str,
    scopes: list,
    text_args: list[str],
    flag_kwargs: dict,
    dispatch: Dispatch,
    cmd_str: str,
) -> CrossResult:
    """Execute a command whose path operands span mounts, via the generics.

    Cross-mount is wiring, not a second implementation: every path operand is
    read or written through ``dispatch`` (which routes it to its owning mount),
    and the shared generic command does the actual work. Two-operand transfer
    and compare commands (cp/mv/diff/cmp) go to ``run_transfer``; N-ary read
    commands (cat/head/tail/wc/grep) go to ``run_aggregate``. Output therefore
    matches the single-mount commands.

    Args:
        cmd_name (str): Command name, such as ``cp``, ``mv``, or ``cat``.
        scopes (list[PathSpec]): Path operands in command-line order.
        text_args (list[str]): Positional text operands (e.g. grep pattern).
        flag_kwargs (dict): Flags parsed from the shared command spec.
        dispatch (Dispatch): Workspace operation dispatcher.
        cmd_str (str): Original command text for the execution record.

    Returns:
        CrossResult: Command output, I/O metadata, and execution record.
    """
    io = build_dispatch_io(dispatch)
    try:
        if cmd_name in TRANSFER_COMMANDS:
            return await run_transfer(cmd_name, scopes, flag_kwargs, io,
                                      cmd_str)
        if cmd_name in MULTI_READ_COMMANDS:
            return await run_aggregate(cmd_name, scopes, text_args,
                                       flag_kwargs, io, cmd_str)
    except (FileNotFoundError, NotADirectoryError, IsADirectoryError,
            PermissionError) as exc:
        err = f"{cmd_name}: {exc}\n".encode()
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command=cmd_str,
                                                         exit_code=1,
                                                         stderr=err)

    err = f"{cmd_name}: cross-mount not supported\n".encode()
    return None, IOResult(exit_code=1,
                          stderr=err), ExecutionNode(command=cmd_str,
                                                     exit_code=1)
