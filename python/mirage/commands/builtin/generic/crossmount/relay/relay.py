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
from mirage.commands.builtin.generic.crossmount.relay.ls import run_ls
from mirage.commands.builtin.generic.crossmount.relay.mv import run_mv
from mirage.commands.builtin.generic.crossmount.relay.paste import run_paste
from mirage.commands.builtin.generic.crossmount.relay.tar import run_tar
from mirage.commands.builtin.generic.crossmount.relay.unzip import run_unzip
from mirage.commands.builtin.generic.crossmount.types import Cmd, CrossResult
from mirage.commands.spec.types import FlagValue
from mirage.ops.types import NamespaceView, SessionView
from mirage.runtime.types import DispatchFn
from mirage.types import PathSpec


async def run_relay(cmd_name: str,
                    scopes: list[PathSpec],
                    text_args: list[str],
                    flag_kwargs: dict[str, FlagValue],
                    dispatch: DispatchFn,
                    storage_key: Callable[[PathSpec], str] | None = None,
                    ns: NamespaceView | None = None,
                    session_view: SessionView | None = None) -> CrossResult:
    """Run a command whose work must see every operand at once.

    Pure wiring: every operand is read or written through ``dispatch``
    primitives on its owning mount, and the shared generic does the work in
    its primitive mode, so output matches the single-mount commands.

    Args:
        cmd_name (str): One of cp, mv, diff, cmp, paste, comm, join, tar,
            unzip, ls.
        scopes (list[PathSpec]): Path operands in command-line order.
        text_args (list[str]): Positional text operands (tar's member
            selectors; empty for the transfer and merge commands).
        flag_kwargs (dict): Flags parsed against the shared command spec.
        dispatch (DispatchFn): Workspace operation dispatcher.
        storage_key (Callable | None): Maps an operand to its storage
            identity, for the transfer commands that must tell a real
            move from one whose two prefixes address a single store.
        ns (NamespaceView | None): Name-plane facts for the generics that
            render them (ls: links, attr overlay, child mounts).
        session_view (SessionView | None): The session plane's door, for
            the generic that renders the session's profile (ls -l).
    """
    if cmd_name == Cmd.LS:
        return await run_ls(scopes, flag_kwargs, dispatch, ns, session_view)
    if cmd_name == Cmd.CP:
        return await run_cp(scopes, flag_kwargs, dispatch, storage_key)
    if cmd_name == Cmd.MV:
        return await run_mv(scopes, flag_kwargs, dispatch, storage_key)
    if cmd_name == Cmd.DIFF:
        return await run_diff(scopes, flag_kwargs, dispatch)
    if cmd_name == Cmd.PASTE:
        return await run_paste(scopes, flag_kwargs, dispatch)
    if cmd_name == Cmd.COMM:
        return await run_comm(scopes, flag_kwargs, dispatch)
    if cmd_name == Cmd.JOIN:
        return await run_join(scopes, flag_kwargs, dispatch)
    if cmd_name == Cmd.TAR:
        return await run_tar(scopes, text_args, flag_kwargs, dispatch)
    if cmd_name == Cmd.UNZIP:
        return await run_unzip(scopes, text_args, flag_kwargs, dispatch)
    return await run_cmp(scopes, flag_kwargs, dispatch)
