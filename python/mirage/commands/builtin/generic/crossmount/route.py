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

from mirage.commands.builtin.generic.crossmount.compare import run_compare
from mirage.commands.builtin.generic.crossmount.detect import (
    COMPARE_COMMANDS, READ_COMMANDS, TRANSFER_COMMANDS)
from mirage.commands.builtin.generic.crossmount.ops import (CrossResult,
                                                            build_dispatch_io)
from mirage.commands.builtin.generic.crossmount.read import run_read
from mirage.commands.builtin.generic.crossmount.transfer import run_transfer
from mirage.io import IOResult
from mirage.types import PathSpec


async def handle_cross_mount(
    cmd_name: str,
    scopes: list[PathSpec],
    text_args: list[str],
    flag_kwargs: dict,
    dispatch: Callable,
) -> CrossResult:
    """Run a command whose path operands span mounts, via the generics.

    Cross-mount is a peer of the generic single-mount commands, not a second
    implementation: every path operand is read or written through ``dispatch``
    (which routes it to its owning mount), and the shared generic command does
    the actual work. ``cp``/``mv`` go to ``run_transfer``; ``diff``/``cmp`` to
    ``run_compare``; the N-ary read commands to ``run_read``. Returns the same
    ``(out, IOResult)`` a generic command returns, so the caller builds the
    execution record uniformly.

    Args:
        cmd_name (str): Command name, such as ``cp``, ``diff``, or ``cat``.
        scopes (list[PathSpec]): Path operands in command-line order.
        text_args (list[str]): Positional text operands (e.g. grep pattern).
        flag_kwargs (dict): Flags parsed from the shared command spec.
        dispatch (Callable): Workspace operation dispatcher.
    """
    io = build_dispatch_io(dispatch)
    try:
        if cmd_name in TRANSFER_COMMANDS:
            return await run_transfer(cmd_name, scopes, flag_kwargs, io)
        if cmd_name in COMPARE_COMMANDS:
            return await run_compare(cmd_name, scopes, flag_kwargs, io)
        if cmd_name in READ_COMMANDS:
            return await run_read(cmd_name, scopes, text_args, flag_kwargs, io)
    except (FileNotFoundError, NotADirectoryError, IsADirectoryError,
            PermissionError) as exc:
        return None, IOResult(exit_code=1,
                              stderr=f"{cmd_name}: {exc}\n".encode())

    err = f"{cmd_name}: cross-mount not supported\n".encode()
    return None, IOResult(exit_code=1, stderr=err)
