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
from mirage.commands.builtin.generic.crossmount.ops import (CrossResult,
                                                            DispatchIO)
from mirage.commands.builtin.generic.mv import mv as generic_mv
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.types import PathSpec


def _flat(scopes: list[PathSpec]) -> list[PathSpec]:
    # Drop each mount prefix so the generic sees one flat namespace of full
    # virtual paths: strip_prefix then equals the full path, so the generic's
    # recursive arithmetic and same-file guard are correct across mounts, and
    # the injected ops route each full path to its owning mount via dispatch.
    return [dataclasses.replace(s, prefix="") for s in scopes]


async def run_transfer(cmd_name: str, scopes: list[PathSpec],
                       flag_kwargs: dict, io: DispatchIO) -> CrossResult:
    """Copy or move path operands that span two mounts.

    The bytes are read from the source mount and written to the destination
    mount through the dispatch-backed ``io``; the shared generic cp/mv does the
    work, so output matches the single-mount commands. Returns the same
    ``(out, IOResult)`` a generic returns; the caller builds the record.

    Args:
        cmd_name (str): ``cp`` or ``mv``.
        scopes (list[PathSpec]): Path operands in command-line order.
        flag_kwargs (dict): Flags parsed against the shared command spec.
        io (DispatchIO): Dispatch-backed ops bundle.
    """
    if cmd_name == "cp":
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
    fl = FlagView(flag_kwargs, spec=SPECS["mv"])
    return await generic_mv(_flat(scopes),
                            rename=functools.partial(io.rename, None),
                            stat=functools.partial(io.stat, None),
                            n=fl.bool("n"),
                            v=fl.bool("v"))
