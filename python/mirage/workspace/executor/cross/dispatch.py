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

from typing import Callable

from mirage.io import IOResult
from mirage.types import PathSpec
from mirage.workspace.executor.aggregate import run_aggregate
from mirage.workspace.executor.cross.adapter import (CrossResult,
                                                     build_dispatch_io)
from mirage.workspace.executor.cross.detect import (MULTI_READ_COMMANDS,
                                                    TRANSFER_COMMANDS)
from mirage.workspace.executor.transfer import run_transfer


async def handle_cross_mount(
    cmd_name: str,
    scopes: list[PathSpec],
    text_args: list[str],
    flag_kwargs: dict,
    dispatch: Callable,
) -> CrossResult:
    """Execute a command whose path operands span mounts, via the generics.

    Cross-mount is a peer of the generic single-mount commands, not a second
    implementation: every path operand is read or written through ``dispatch``
    (which routes it to its owning mount), and the shared generic command does
    the actual work. Two-operand transfer and compare commands (cp/mv/diff/cmp)
    go to ``run_transfer``; N-ary read commands (cat/head/tail/wc/grep) go to
    ``run_aggregate``. Returns the same ``(out, IOResult)`` a generic command
    returns, so the caller builds the execution record uniformly.

    Args:
        cmd_name (str): Command name, such as ``cp``, ``mv``, or ``cat``.
        scopes (list[PathSpec]): Path operands in command-line order.
        text_args (list[str]): Positional text operands (e.g. grep pattern).
        flag_kwargs (dict): Flags parsed from the shared command spec.
        dispatch (Callable): Workspace operation dispatcher.
    """
    io = build_dispatch_io(dispatch)
    try:
        if cmd_name in TRANSFER_COMMANDS:
            return await run_transfer(cmd_name, scopes, flag_kwargs, io)
        if cmd_name in MULTI_READ_COMMANDS:
            return await run_aggregate(cmd_name, scopes, text_args,
                                       flag_kwargs, io)
    except (FileNotFoundError, NotADirectoryError, IsADirectoryError,
            PermissionError) as exc:
        return None, IOResult(exit_code=1,
                              stderr=f"{cmd_name}: {exc}\n".encode())

    err = f"{cmd_name}: cross-mount not supported\n".encode()
    return None, IOResult(exit_code=1, stderr=err)
