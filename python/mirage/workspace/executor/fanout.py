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

import functools
import logging
from typing import Any

from mirage.commands.builtin.generic.crossmount.constants import (
    DISPATCH_BUILDERS,
)
from mirage.commands.builtin.generic.crossmount.du import run_du
from mirage.commands.builtin.generic.crossmount.find import run_find
from mirage.commands.builtin.generic.crossmount.route import handle_cross_mount
from mirage.commands.builtin.generic.crossmount.search import walks_mounts
from mirage.commands.builtin.generic.crossmount.types import (
    CrossResult,
    RunSingle,
)
from mirage.commands.builtin.generic_bind.dispatch import run_dispatch
from mirage.commands.errors import CommandTimeoutError, UsageError
from mirage.commands.spec.types import FlagValue
from mirage.commands.spec.usage import read_fail_exit_code
from mirage.errors.render import format_fs_error
from mirage.io import IOResult
from mirage.io.stream import materialize
from mirage.io.types import ByteSource
from mirage.runtime.types import DispatchFn
from mirage.shell.bytes import encode_text
from mirage.types import PathSpec, Producer
from mirage.utils.hidden import path_visible
from mirage.view.types import NamespaceView, SessionView
from mirage.workspace.mount import (
    MountCommandUnsupported,
    MountEntry,
    MountRegistry,
)
from mirage.workspace.types import ExecutionNode

logger = logging.getLogger(__name__)

_TRAVERSAL_CMDS = frozenset({"find", "du"})


async def _own_part(
    run_single: RunSingle,
    registry: MountRegistry,
    dispatch: DispatchFn,
    cwd: str,
    ns: NamespaceView | None,
    cmd_name: str,
    paths: list[PathSpec],
    texts: list[str],
    flag_kwargs: dict[str, FlagValue],
    **options: Any,
) -> CrossResult:
    """One mount's part of a find or du, on the command that mount serves.

    A mount that registers no find or du of its own still answers its
    part through the generic walk over the dispatcher, since both read
    only the metadata every mount serves.

    Args:
        run_single (RunSingle): The executor's single-mount runner.
        registry (MountRegistry): Registry holding the mount table.
        dispatch (DispatchFn): Workspace operation dispatcher.
        cwd (str): Session working directory.
        ns (NamespaceView | None): Name-plane facts.
        cmd_name (str): find or du.
        paths (list[PathSpec]): The part's start point.
        texts (list[str]): Positional text operands.
        flag_kwargs (dict[str, FlagValue]): Parsed flags.
        **options (Any): Forwarded to ``run_single``.
    """
    try:
        await registry.resolve_mount(cmd_name, paths, cwd)
    except MountCommandUnsupported:
        return await run_dispatch(
            DISPATCH_BUILDERS[cmd_name],
            paths,
            texts,
            flag_kwargs,
            dispatch,
            cwd,
            ns,
            options.get("stdin"),
        )
    return await run_single(cmd_name, paths, texts, flag_kwargs, **options)


def _should_fan_out(
    cmd_name: str,
    paths: list[PathSpec],
    flag_kwargs: dict[str, FlagValue],
    registry: MountRegistry,
) -> bool:
    """Whether `cmd` on this path should run across multiple mounts.

    True when the command is in the traversal whitelist (find/du)
    and the path has at least one descendant mount; or for grep with
    -r/-R; or for ls -R. Returns False when there's no descendant
    mount under the path (single-mount dispatch is correct), and for a
    walk told to keep to its operand's filesystem (``du -x``, ``rg
    --one-file-system``), since a mount is one.
    """
    # Use the raw mount table: hidden descendants still shadow backend keys.
    # Refused operands name nothing. Every other operand can own nested
    # mounts, regardless of where it appears in the command line.
    if not any(
        p.walk_error is None and registry.descendant_mounts(p.virtual)
        for p in paths
    ):
        return False
    if cmd_name == "du":
        return flag_kwargs.get("one_file_system") is not True
    if cmd_name in _TRAVERSAL_CMDS:
        return True
    if cmd_name == "ls":
        return flag_kwargs.get("recursive") is True
    return walks_mounts(cmd_name, flag_kwargs)


async def _fan_out_traversal(
    cmd_name: str,
    paths: list[PathSpec],
    texts: list[str],
    flag_kwargs: dict[str, FlagValue],
    registry: MountRegistry,
    primary_mount: MountEntry,
    cwd: str,
    cmd_str: str,
    stdin: ByteSource | None,
    ns: NamespaceView | None = None,
    session_view: SessionView | None = None,
    dispatch: DispatchFn | None = None,
    native: RunSingle | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Compose a traversal over the mounts inside its operands.

    Each mount's own command answers for its part: find and du from
    every mount's structured rows and measurements, a search from its
    owned scopes. No output is inspected to recover paths or repair
    depth and totals.

    Args:
        cmd_name (str): find, du, ls or a recursive grep/rg.
        paths (list[PathSpec]): Operands in command-line order.
        texts (list[str]): Positional text operands.
        flag_kwargs (dict[str, FlagValue]): Parsed flags.
        registry (MountRegistry): Registry holding the mount table.
        primary_mount (MountEntry): The mount serving the operands.
        cwd (str): Session working directory.
        cmd_str (str): The command as typed, for the execution record.
        stdin (ByteSource | None): Standard input for the command.
        ns (NamespaceView | None): Name-plane facts.
        session_view (SessionView | None): The session plane's door.
        dispatch (DispatchFn | None): Workspace operation dispatcher.
        native (RunSingle | None): Single-mount runner each mount's part
            of the walk runs on.
    """
    if dispatch is None or native is None:
        raise ValueError("traversal requires dispatcher and native execution")
    part = functools.partial(_own_part, native, registry, dispatch, cwd, ns)
    try:
        if cmd_name == "find":
            stdout, io = await run_find(
                paths, texts, flag_kwargs, dispatch, part, cwd, ns, stdin
            )
        elif cmd_name == "du":
            stdout, io = await run_du(
                paths,
                texts,
                flag_kwargs,
                dispatch,
                part,
                cwd,
                ns,
                stdin,
                nested=True,
            )
        else:
            stdout, io = await handle_cross_mount(
                cmd_name,
                paths,
                texts,
                flag_kwargs,
                dispatch,
                native,
                stdin=stdin,
                ns=ns,
                session_view=session_view,
                cwd=cwd,
            )
    except UsageError as exc:
        stdout, io = (
            None,
            IOResult(exit_code=exc.exit_code, stderr=encode_text(f"{exc}\n")),
        )
    except CommandTimeoutError:
        raise
    except Exception as exc:
        # A backend failure anywhere in the walk (a 5xx from a nested
        # mount) is this command's result, in its voice, as the
        # single-mount door reports it; the rest of the line still runs.
        logger.debug("%s traversal failed", cmd_name, exc_info=True)
        stdout, io = (
            None,
            IOResult(
                exit_code=read_fail_exit_code(cmd_name, exc),
                stderr=format_fs_error(cmd_name, exc, paths),
            ),
        )
    # Only the mounts the walk can reach bound its output: a hidden one
    # never contributes a row, so its stricter limit must not apply.
    prefixes = {primary_mount.prefix}
    vis = ns.visibility if ns is not None else None
    for path in paths:
        if path.walk_error is None:
            prefixes.update(
                m.prefix
                for m in registry.descendant_mounts(path.virtual)
                if path_visible(vis, "/" + m.prefix.strip("/"))
            )
    io.producer = Producer(command=cmd_name, prefixes=tuple(sorted(prefixes)))
    return (
        stdout,
        io,
        ExecutionNode(
            command=cmd_str,
            exit_code=io.exit_code,
            stderr=await materialize(io.stderr),
        ),
    )


async def run_with_fanout(
    run_single: RunSingle,
    registry: MountRegistry,
    cwd: str,
    ns: NamespaceView | None,
    session_view: SessionView | None,
    cmd_name: str,
    paths: list[PathSpec],
    texts: list[str],
    flag_kwargs: dict[str, FlagValue],
    *,
    stdin: ByteSource | None = None,
    resolve_hint: PathSpec | None = None,
    dispatch: DispatchFn | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """One operand's native run, fanned out over the mounts nested in it.

    A line whose operands span mounts runs once per operand on the
    operand's owning mount, and that runner is single-mount by
    construction: it never descends into a mount nested *under* the
    operand. So ``du /base /other`` reported the parent backend's keys
    shadowed by a mount at ``/base/inner`` and none of that mount's own,
    while ``du /base`` on the same tree got both right. Wrapping the
    per-operand runner is what makes the two agree, and it is a
    pass-through for everything the traversal fan-out does not claim.

    Args:
        run_single (RunSingle): the executor's single-mount runner.
        registry (MountRegistry): registry holding the mount table.
        cwd (str): session working directory.
        ns (NamespaceView | None): the name plane's facts, offered
            whole to the sub-runs.
        session_view (SessionView | None): The session profile rendered by ls.
        dispatch (DispatchFn | None): Operations for a unified rg walk.
        cmd_name (str): command name.
        paths (list[PathSpec]): this operand, as a one-element list.
        texts (list[str]): positional text operands.
        flag_kwargs (dict): parsed flags.
        stdin (ByteSource | None): standard input for the command.
        resolve_hint (PathSpec | None): mount-resolution path for a run
            with no operand of its own (the stream strategy's single
            native run over the merged bytes).
    """
    if not _should_fan_out(cmd_name, paths, flag_kwargs, registry):
        if cmd_name in _TRAVERSAL_CMDS and dispatch is not None:
            return await _own_part(
                run_single,
                registry,
                dispatch,
                cwd,
                ns,
                cmd_name,
                paths,
                texts,
                flag_kwargs,
                stdin=stdin,
                resolve_hint=resolve_hint,
            )
        return await run_single(
            cmd_name,
            paths,
            texts,
            flag_kwargs,
            stdin=stdin,
            resolve_hint=resolve_hint,
        )
    try:
        mount = await registry.resolve_mount(cmd_name, paths, cwd)
    except MountCommandUnsupported:
        # The single-mount runner owns the wording for a command this
        # mount does not serve, so let it report rather than re-raising.
        mount = None
    if mount is None:
        return await run_single(
            cmd_name,
            paths,
            texts,
            flag_kwargs,
            stdin=stdin,
            resolve_hint=resolve_hint,
        )
    stdout, io, _ = await _fan_out_traversal(
        cmd_name,
        paths,
        texts,
        flag_kwargs,
        registry,
        mount,
        cwd,
        cmd_name,
        stdin,
        ns=ns,
        session_view=session_view,
        dispatch=dispatch,
        native=run_single,
    )
    return stdout, io
