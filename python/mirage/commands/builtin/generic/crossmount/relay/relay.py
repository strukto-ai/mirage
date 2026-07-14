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

from mirage.commands.builtin.generic.crossmount.relay.cmp import run_cmp
from mirage.commands.builtin.generic.crossmount.relay.comm import run_comm
from mirage.commands.builtin.generic.crossmount.relay.cp import run_cp
from mirage.commands.builtin.generic.crossmount.relay.diff import run_diff
from mirage.commands.builtin.generic.crossmount.relay.join import run_join
from mirage.commands.builtin.generic.crossmount.relay.mv import run_mv
from mirage.commands.builtin.generic.crossmount.relay.paste import run_paste
from mirage.commands.builtin.generic.crossmount.types import Cmd, CrossResult
from mirage.types import PathSpec


async def run_relay(cmd_name: str, scopes: list[PathSpec], flag_kwargs: dict,
                    dispatch: Callable) -> CrossResult:
    """Run a command whose data must colocate across mounts.

    Pure wiring: every operand is read or written through ``dispatch``
    primitives on its owning mount, and the shared generic does the work in
    its primitive mode, so output matches the single-mount commands.

    Args:
        cmd_name (str): One of cp, mv, diff, cmp, paste, comm, join.
        scopes (list[PathSpec]): Path operands in command-line order.
        flag_kwargs (dict): Flags parsed against the shared command spec.
        dispatch (Callable): Workspace operation dispatcher.
    """
    if cmd_name == Cmd.CP:
        return await run_cp(scopes, flag_kwargs, dispatch)
    if cmd_name == Cmd.MV:
        return await run_mv(scopes, flag_kwargs, dispatch)
    if cmd_name == Cmd.DIFF:
        return await run_diff(scopes, flag_kwargs, dispatch)
    if cmd_name == Cmd.PASTE:
        return await run_paste(scopes, flag_kwargs, dispatch)
    if cmd_name == Cmd.COMM:
        return await run_comm(scopes, flag_kwargs, dispatch)
    if cmd_name == Cmd.JOIN:
        return await run_join(scopes, flag_kwargs, dispatch)
    return await run_cmp(scopes, flag_kwargs, dispatch)
