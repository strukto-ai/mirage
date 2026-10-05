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

from mirage.commands.builtin.generic.crossmount.constants import (
    DISPATCH_BUILDERS,
    RELAY_COMMANDS,
)
from mirage.commands.builtin.generic.crossmount.relay.awk import run_awk
from mirage.commands.builtin.generic.crossmount.relay.cp import run_cp
from mirage.commands.builtin.generic.crossmount.relay.ls import run_ls
from mirage.commands.builtin.generic.crossmount.relay.mv import run_mv
from mirage.commands.builtin.generic.crossmount.relay.sed import run_sed
from mirage.commands.builtin.generic.crossmount.relay.tar import run_tar
from mirage.commands.builtin.generic.crossmount.relay.tee import run_tee
from mirage.commands.builtin.generic.crossmount.relay.unzip import run_unzip
from mirage.commands.builtin.generic.crossmount.relay.wc import run_wc
from mirage.commands.builtin.generic.crossmount.relay.zip_cmd import run_zip
from mirage.commands.builtin.generic.crossmount.types import (
    Cmd,
    CrossResult,
    RunSingle,
)
from mirage.commands.builtin.generic_bind.dispatch import run_dispatch
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource
from mirage.ops.types import NamespaceView, SessionView
from mirage.runtime.types import DispatchFn
from mirage.types import PathSpec


async def run_relay(
    cmd_name: str,
    scopes: list[PathSpec],
    text_args: list[str],
    flag_kwargs: dict[str, FlagValue],
    dispatch: DispatchFn,
    run_single: RunSingle,
    storage_key: Callable[[PathSpec], str] | None = None,
    ns: NamespaceView | None = None,
    session_view: SessionView | None = None,
    stdin: ByteSource | None = None,
    cwd: str = "/",
    argv: tuple[str, ...] = (),
) -> CrossResult:
    """Run a command whose work must see every operand at once.

    Pure wiring: every operand is read or written through ``dispatch``
    primitives on its owning mount, and the shared generic does the work in
    its primitive mode, so output matches the single-mount commands. wc is
    the one whose operands are counted by their own mount's command, since
    a mount can count without reading; only its layout spans the line.
    awk runs once on its first file's mount, reading the rest through
    the dispatcher, so every operand keeps its own name.

    Args:
        cmd_name (str): One of cp, mv, diff, cmp, paste, comm, join, tar,
            tee, unzip, zip, ls, sort, wc, awk, sed, realpath.
        scopes (list[PathSpec]): Path operands in command-line order.
        text_args (list[str]): Positional text operands (tar's member
            selectors, cmp's skips; empty for the transfer and merge
            commands).
        flag_kwargs (dict): Flags parsed against the shared command spec.
        dispatch (DispatchFn): Workspace operation dispatcher.
        run_single (RunSingle): Single-mount runner (wc's per-operand
            counts, awk's one run).
        storage_key (Callable | None): Maps an operand to its storage
            identity, for the transfer commands that must tell a real
            move from one whose two prefixes address a single store.
        ns (NamespaceView | None): Name-plane facts for the generics that
            render them (ls: links, attr overlay, child mounts) and for
            the archivers' scan (tar, zip: links, mount boundaries).
        session_view (SessionView | None): The session plane's door, for
            the generic that renders the session's profile (ls -l).
        stdin (ByteSource | None): The line's input, which a ``-``
            operand reads.
        cwd (str): The session's working directory, which cp resolves a
            typed link source against.
        argv (tuple[str, ...]): Original argument spellings for diagnostics.
    """
    if cmd_name not in RELAY_COMMANDS:
        raise ValueError(f"Unsupported cross-mount relay command: {cmd_name}")
    if cmd_name == Cmd.AWK:
        return await run_awk(scopes, text_args, flag_kwargs, run_single, stdin)
    if cmd_name == Cmd.SED:
        return await run_sed(
            scopes,
            text_args,
            flag_kwargs,
            dispatch,
            stdin,
            cwd,
            argv,
            session_view.snapshot() if session_view is not None else None,
        )
    if cmd_name == Cmd.WC:
        return await run_wc(
            scopes, flag_kwargs, dispatch, run_single, cwd, ns, stdin
        )
    if cmd_name == Cmd.LS:
        return await run_ls(scopes, flag_kwargs, dispatch, ns, session_view)
    if cmd_name == Cmd.CP:
        return await run_cp(
            scopes, flag_kwargs, dispatch, storage_key, ns, cwd, stdin
        )
    if cmd_name == Cmd.MV:
        return await run_mv(
            scopes, flag_kwargs, dispatch, storage_key, ns, stdin
        )
    if cmd_name == Cmd.TAR:
        return await run_tar(
            scopes, text_args, flag_kwargs, dispatch, ns, stdin
        )
    if cmd_name == Cmd.TEE:
        return await run_tee(scopes, flag_kwargs, dispatch, stdin)
    if cmd_name == Cmd.UNZIP:
        return await run_unzip(scopes, text_args, flag_kwargs, dispatch)
    if cmd_name == Cmd.ZIP:
        return await run_zip(scopes, flag_kwargs, dispatch, ns)
    if cmd_name in DISPATCH_BUILDERS:
        return await run_dispatch(
            DISPATCH_BUILDERS[cmd_name],
            scopes,
            text_args,
            flag_kwargs,
            dispatch,
            cwd,
            ns,
            stdin,
            argv,
        )
    raise ValueError(f"No cross-mount composition for {cmd_name}")
