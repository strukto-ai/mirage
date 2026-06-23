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

from mirage.commands.builtin.generic.cmp import cmp_cmd as generic_cmp
from mirage.commands.builtin.generic.crossmount.ops import (CrossResult,
                                                            DispatchIO)
from mirage.commands.builtin.generic.diff import diff as generic_diff
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.types import PathSpec


def _flat(scopes: list[PathSpec]) -> list[PathSpec]:
    return [dataclasses.replace(s, prefix="") for s in scopes]


async def run_compare(cmd_name: str, scopes: list[PathSpec], flag_kwargs: dict,
                      io: DispatchIO) -> CrossResult:
    """Compare two files that live on different mounts.

    Both files are read through the dispatch-backed ``io`` and handed to the
    shared generic diff/cmp, so output matches the single-mount commands.
    Returns the same ``(out, IOResult)`` a generic command returns; the caller
    builds the record.

    Args:
        cmd_name (str): ``diff`` or ``cmp``.
        scopes (list[PathSpec]): The two path operands.
        flag_kwargs (dict): Flags parsed against the shared command spec.
        io (DispatchIO): Dispatch-backed ops bundle.
    """
    if cmd_name == "diff":
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
