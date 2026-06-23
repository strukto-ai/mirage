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

import dataclasses
import functools

from mirage.commands.builtin.generic.cmp import cmp_cmd as generic_cmp
from mirage.commands.builtin.generic.cp import cp as generic_cp
from mirage.commands.builtin.generic.diff import diff as generic_diff
from mirage.commands.builtin.generic.mv import mv as generic_mv
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.io import IOResult
from mirage.types import PathSpec
from mirage.workspace.executor.cross.adapter import (DispatchIO,
                                                     build_dispatch_io)
from mirage.workspace.executor.cross.detect import MULTI_READ_COMMANDS
from mirage.workspace.executor.cross.read import cross_multi_read
from mirage.workspace.executor.cross.types import CrossResult, Dispatch
from mirage.workspace.types import ExecutionNode


def _flat(scopes: list[PathSpec]) -> list[PathSpec]:
    # Drop each mount prefix so the generic sees one flat namespace of full
    # virtual paths: strip_prefix then equals the full path, so the generic's
    # recursive arithmetic and same-file guard are correct across mounts, and
    # the injected ops route each full path to its owning mount via dispatch.
    return [dataclasses.replace(s, prefix="") for s in scopes]


def _node(cmd_str: str, io: IOResult) -> ExecutionNode:
    return ExecutionNode(command=cmd_str,
                         exit_code=io.exit_code,
                         stderr=io.stderr)


async def _cp(scopes: list[PathSpec], flag_kwargs: dict, io: DispatchIO,
              cmd_str: str) -> CrossResult:
    fl = FlagView(flag_kwargs, spec=SPECS["cp"])
    out, res = await generic_cp(_flat(scopes),
                                copy=functools.partial(io.copy, None),
                                find=functools.partial(io.find, None),
                                find_type="a",
                                stat=functools.partial(io.stat, None),
                                recursive=fl.bool("r") or fl.bool("R")
                                or fl.bool("a"),
                                n=fl.bool("n"),
                                v=fl.bool("v"))
    return out, res, _node(cmd_str, res)


async def _mv(scopes: list[PathSpec], flag_kwargs: dict, io: DispatchIO,
              cmd_str: str) -> CrossResult:
    fl = FlagView(flag_kwargs, spec=SPECS["mv"])
    out, res = await generic_mv(_flat(scopes),
                                rename=functools.partial(io.rename, None),
                                stat=functools.partial(io.stat, None),
                                n=fl.bool("n"),
                                v=fl.bool("v"))
    return out, res, _node(cmd_str, res)


async def _diff(scopes: list[PathSpec], flag_kwargs: dict, io: DispatchIO,
                cmd_str: str) -> CrossResult:
    fl = FlagView(flag_kwargs, spec=SPECS["diff"])
    out, res = await generic_diff(_flat(scopes),
                                  read_bytes=io.read_bytes,
                                  readdir_fn=io.readdir,
                                  stat_fn=io.stat,
                                  accessor=None,
                                  i=fl.bool("i"),
                                  w=fl.bool("w"),
                                  b=fl.bool("b"),
                                  e=fl.bool("e"),
                                  u=fl.bool("u"),
                                  q=fl.bool("q"),
                                  r=fl.bool("r"))
    return out, res, _node(cmd_str, res)


async def _cmp(scopes: list[PathSpec], flag_kwargs: dict, io: DispatchIO,
               cmd_str: str) -> CrossResult:
    fl = FlagView(flag_kwargs, spec=SPECS["cmp"])
    limit = fl.str("n")
    skip = fl.str("i")
    out, res = await generic_cmp(
        _flat(scopes),
        read_bytes=io.read_bytes,
        accessor=None,
        silent=fl.bool("s"),
        verbose=fl.bool("args_l"),
        limit=int(limit) if limit is not None else None,
        print_bytes=fl.bool("b"),
        skip=int(skip) if skip is not None else None)
    return out, res, _node(cmd_str, res)


async def handle_cross_mount(
    cmd_name: str,
    scopes: list[PathSpec],
    text_args: list[str],
    flag_kwargs: dict,
    dispatch: Dispatch,
    cmd_str: str,
) -> CrossResult:
    """Execute a command whose path operands span mounts, via the generics.

    Cross-mount is wiring, not a second implementation: every path operand is
    read or written through ``dispatch`` (which routes it to its owning mount),
    and the shared generic command does the actual cp/mv/diff/cmp/cat/head/
    tail/wc/grep work. Output therefore matches the single-mount commands.

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
        if cmd_name == "cp":
            return await _cp(scopes, flag_kwargs, io, cmd_str)
        if cmd_name == "mv":
            return await _mv(scopes, flag_kwargs, io, cmd_str)
        if cmd_name == "diff":
            return await _diff(scopes, flag_kwargs, io, cmd_str)
        if cmd_name == "cmp":
            return await _cmp(scopes, flag_kwargs, io, cmd_str)
        if cmd_name in MULTI_READ_COMMANDS:
            return await cross_multi_read(cmd_name, scopes, text_args,
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
