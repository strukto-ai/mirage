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
from mirage.types import PathSpec
from mirage.workspace.executor.cross.adapter import CrossResult, DispatchIO


def _flat(scopes: list[PathSpec]) -> list[PathSpec]:
    # Drop each mount prefix so the generic sees one flat namespace of full
    # virtual paths: strip_prefix then equals the full path, so the generic's
    # recursive arithmetic and same-file guard are correct across mounts, and
    # the injected ops route each full path to its owning mount via dispatch.
    return [dataclasses.replace(s, prefix="") for s in scopes]


async def _cp(scopes: list[PathSpec], flag_kwargs: dict,
              io: DispatchIO) -> CrossResult:
    fl = FlagView(flag_kwargs, spec=SPECS["cp"])
    return await generic_cp(_flat(scopes),
                            copy=functools.partial(io.copy, None),
                            find=functools.partial(io.find, None),
                            find_type="a",
                            stat=functools.partial(io.stat, None),
                            recursive=fl.bool("r") or fl.bool("R")
                            or fl.bool("a"),
                            n=fl.bool("n"),
                            v=fl.bool("v"))


async def _mv(scopes: list[PathSpec], flag_kwargs: dict,
              io: DispatchIO) -> CrossResult:
    fl = FlagView(flag_kwargs, spec=SPECS["mv"])
    return await generic_mv(_flat(scopes),
                            rename=functools.partial(io.rename, None),
                            stat=functools.partial(io.stat, None),
                            n=fl.bool("n"),
                            v=fl.bool("v"))


async def _diff(scopes: list[PathSpec], flag_kwargs: dict,
                io: DispatchIO) -> CrossResult:
    fl = FlagView(flag_kwargs, spec=SPECS["diff"])
    return await generic_diff(_flat(scopes),
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


async def _cmp(scopes: list[PathSpec], flag_kwargs: dict,
               io: DispatchIO) -> CrossResult:
    fl = FlagView(flag_kwargs, spec=SPECS["cmp"])
    limit = fl.str("n")
    skip = fl.str("i")
    return await generic_cmp(_flat(scopes),
                             read_bytes=io.read_bytes,
                             accessor=None,
                             silent=fl.bool("s"),
                             verbose=fl.bool("args_l"),
                             limit=int(limit) if limit is not None else None,
                             print_bytes=fl.bool("b"),
                             skip=int(skip) if skip is not None else None)


async def run_transfer(cmd_name: str, scopes: list[PathSpec],
                       flag_kwargs: dict, io: DispatchIO) -> CrossResult:
    """Copy, move, or compare path operands that span two mounts.

    These are the two-operand commands: a source and a destination (cp, mv) or
    two files to compare (diff, cmp). Each operand is read or written through
    the dispatch-backed ``io`` (routing it to its owning mount), and the shared
    generic command does the work, so output matches the single-mount commands.
    Returns the same ``(out, IOResult)`` a generic command returns; the caller
    builds the execution record.

    Args:
        cmd_name (str): One of cp, mv, diff, cmp.
        scopes (list[PathSpec]): Path operands in command-line order.
        flag_kwargs (dict): Flags parsed against the shared command spec.
        io (DispatchIO): Dispatch-backed ops bundle.
    """
    if cmd_name == "cp":
        return await _cp(scopes, flag_kwargs, io)
    if cmd_name == "mv":
        return await _mv(scopes, flag_kwargs, io)
    if cmd_name == "diff":
        return await _diff(scopes, flag_kwargs, io)
    return await _cmp(scopes, flag_kwargs, io)
