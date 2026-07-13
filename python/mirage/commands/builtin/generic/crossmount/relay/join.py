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
from mirage.commands.builtin.generic.join import join_cmd as generic_join
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.types import PathSpec


async def run_join(scopes: list[PathSpec], flag_kwargs: dict,
                   dispatch: Callable) -> CrossResult:
    """Join two files on different mounts via the shared generic join.

    Pure wiring: both sides are read through dispatch-relayed primitives
    on their owning mounts, matching the single-mount builder.

    Args:
        scopes (list[PathSpec]): The two path operands.
        flag_kwargs (dict): Flags parsed against the shared join spec.
        dispatch (Callable): Workspace operation dispatcher.
    """
    fl = FlagView(flag_kwargs, spec=SPECS["join"])
    field1 = fl.str("args_1")
    field2 = fl.str("2")
    return await generic_join(flat_scopes(scopes),
                              read_bytes=functools.partial(
                                  relay, dispatch, "read"),
                              accessor=None,
                              field1=int(field1 or 1) - 1,
                              field2=int(field2 or 1) - 1,
                              separator=fl.str("t"),
                              also_unpairable=fl.str("a"),
                              only_unpairable=fl.str("v"),
                              empty_value=fl.str("e"),
                              output_format=fl.str("o"))
