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

from mirage.commands.builtin.generic.cp import cp as generic_cp
from mirage.commands.builtin.generic.crossmount.primitives import (CrossResult,
                                                                   relay)
from mirage.commands.builtin.generic.mv import mv as generic_mv
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.types import PathSpec


def _flat(scopes: list[PathSpec]) -> list[PathSpec]:
    # Address by full virtual path so the generic sees one flat namespace;
    # the relayed primitives route each full path to its mount.
    return [
        dataclasses.replace(s, resource_path=s.virtual.strip("/"))
        for s in scopes
    ]


async def run_transfer(cmd_name: str, scopes: list[PathSpec],
                       flag_kwargs: dict, dispatch) -> CrossResult:
    """Copy or move path operands that span two mounts.

    Pure wiring: the shared generic cp/mv runs in its primitive mode (no native
    copy/rename), reading from the source mount and writing to the destination
    mount through ``dispatch``-relayed primitives. Output matches the
    single-mount commands; the caller builds the execution record.

    Args:
        cmd_name (str): ``cp`` or ``mv``.
        scopes (list[PathSpec]): Path operands in command-line order.
        flag_kwargs (dict): Flags parsed against the shared command spec.
        dispatch (Callable): Workspace operation dispatcher.
    """
    p = functools.partial
    prim = dict(
        stat=p(relay, dispatch, "stat", None),
        read_bytes=p(relay, dispatch, "read", None),
        write=p(relay, dispatch, "write", None),
        mkdir=p(relay, dispatch, "mkdir", None),
        readdir=p(relay, dispatch, "readdir", None),
    )
    flat = _flat(scopes)
    if cmd_name == "cp":
        fl = FlagView(flag_kwargs, spec=SPECS["cp"])
        return await generic_cp(flat,
                                recursive=fl.bool("r") or fl.bool("R")
                                or fl.bool("a"),
                                n=fl.bool("n"),
                                v=fl.bool("v"),
                                **prim)
    fl = FlagView(flag_kwargs, spec=SPECS["mv"])
    return await generic_mv(flat,
                            n=fl.bool("n"),
                            v=fl.bool("v"),
                            unlink=p(relay, dispatch, "unlink", None),
                            rmdir=p(relay, dispatch, "rmdir", None),
                            **prim)
