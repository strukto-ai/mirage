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

from mirage.commands.builtin.generic.crossmount.detect import strategy_for
from mirage.commands.builtin.generic.crossmount.fanout import run_fanout
from mirage.commands.builtin.generic.crossmount.relay import run_relay
from mirage.commands.builtin.generic.crossmount.stream import run_stream
from mirage.commands.builtin.generic.crossmount.types import (CrossResult,
                                                              RunSingle,
                                                              Strategy)
from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.types import PathSpec
from mirage.utils.errors import FS_ERRORS, format_fs_error


async def handle_cross_mount(
    cmd_name: str,
    scopes: list[PathSpec],
    text_args: list[str],
    flag_kwargs: dict,
    dispatch: Callable,
    run_single: RunSingle,
    stdin: ByteSource | None = None,
) -> CrossResult:
    """Run a command whose path operands span mounts.

    Every command combines per-mount work under one of three strategies
    (see ``Strategy``): STREAM merges raw per-operand bytes and runs the
    command once on the merged stream, FANOUT runs the command natively
    once per operand and combines the outputs, RELAY moves per-file data
    through the dispatcher into one shared generic. STREAM and FANOUT
    execute through ``run_single``, so each mount expands its own glob
    operands and uses its own native command implementation.

    Args:
        cmd_name (str): Command name, such as ``cp``, ``sort``, or ``grep``.
        scopes (list[PathSpec]): Path operands in command-line order.
        text_args (list[str]): Positional text operands (grep pattern,
            find expression).
        flag_kwargs (dict): Flags parsed from the shared command spec.
        dispatch (Callable): Workspace operation dispatcher (RELAY).
        run_single (RunSingle): Executor-injected single-mount runner
            (STREAM and FANOUT).
        stdin (ByteSource | None): Original stdin (tee re-feeds it per
            operand).
    """
    try:
        strategy = strategy_for(cmd_name, flag_kwargs)
        if strategy is Strategy.RELAY:
            return await run_relay(cmd_name, scopes, flag_kwargs, dispatch)
        if strategy is Strategy.STREAM:
            return await run_stream(cmd_name, scopes, text_args, flag_kwargs,
                                    run_single)
        return await run_fanout(cmd_name,
                                scopes,
                                text_args,
                                flag_kwargs,
                                run_single,
                                stdin=stdin)
    except FS_ERRORS as exc:
        return None, IOResult(exit_code=1,
                              stderr=format_fs_error(cmd_name, exc, scopes))
