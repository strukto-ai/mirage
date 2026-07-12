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
from typing import Callable

from mirage.commands.builtin.generic.crossmount.types import CrossResult
from mirage.commands.builtin.generic.crossmount.utils import flat_scopes, relay
from mirage.commands.builtin.generic.paste import paste as generic_paste
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.types import PathSpec


async def run_paste(scopes: list[PathSpec], flag_kwargs: dict,
                    dispatch: Callable) -> CrossResult:
    """Paste files on different mounts via the shared generic paste.

    Pure wiring: every operand is read through dispatch-relayed
    primitives on its owning mount, matching the single-mount builder.

    Args:
        scopes (list[PathSpec]): Path operands in command-line order.
        flag_kwargs (dict): Flags parsed against the shared paste spec.
        dispatch (Callable): Workspace operation dispatcher.
    """
    fl = FlagView(flag_kwargs, spec=SPECS["paste"])
    d = fl.str("d")
    return await generic_paste(flat_scopes(scopes),
                               read_bytes=functools.partial(
                                   relay, dispatch, "read"),
                               accessor=None,
                               delimiter=d if d else "\t",
                               serial=fl.bool("s"))
