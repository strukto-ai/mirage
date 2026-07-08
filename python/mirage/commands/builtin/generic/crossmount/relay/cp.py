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

from mirage.commands.builtin.generic.cp import cp as generic_cp
from mirage.commands.builtin.generic.crossmount.types import CrossResult
from mirage.commands.builtin.generic.crossmount.utils import (
    flat_scopes, transfer_primitives)
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.types import PathSpec


async def run_cp(scopes: list[PathSpec], flag_kwargs: dict,
                 dispatch: Callable) -> CrossResult:
    """Copy operands that span mounts via the shared generic cp.

    Pure wiring: the generic runs in its primitive mode (no native copy),
    reading from the source mount and writing to the destination mount
    through dispatch-relayed primitives.

    Args:
        scopes (list[PathSpec]): Path operands in command-line order.
        flag_kwargs (dict): Flags parsed against the shared cp spec.
        dispatch (Callable): Workspace operation dispatcher.
    """
    fl = FlagView(flag_kwargs, spec=SPECS["cp"])
    return await generic_cp(flat_scopes(scopes),
                            recursive=fl.bool("r") or fl.bool("R")
                            or fl.bool("a"),
                            n=fl.bool("n"),
                            v=fl.bool("v"),
                            **transfer_primitives(dispatch))
