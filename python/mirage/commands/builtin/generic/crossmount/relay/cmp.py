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

from mirage.commands.builtin.generic.cmp import cmp_cmd as generic_cmp
from mirage.commands.builtin.generic.crossmount.types import CrossResult
from mirage.commands.builtin.generic.crossmount.utils import flat_scopes, relay
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.types import PathSpec


async def run_cmp(scopes: list[PathSpec], flag_kwargs: dict,
                  dispatch: Callable) -> CrossResult:
    """Byte-compare two files on different mounts via the shared generic.

    Pure wiring: both sides are read through dispatch-relayed primitives.

    Args:
        scopes (list[PathSpec]): The two path operands.
        flag_kwargs (dict): Flags parsed against the shared cmp spec.
        dispatch (Callable): Workspace operation dispatcher.
    """
    fl = FlagView(flag_kwargs, spec=SPECS["cmp"])
    limit = fl.as_str("n")
    skip = fl.as_str("i")
    return await generic_cmp(flat_scopes(scopes),
                             read_bytes=functools.partial(
                                 relay, dispatch, "read"),
                             accessor=None,
                             silent=fl.as_bool("s"),
                             verbose=fl.as_bool("args_l"),
                             limit=int(limit) if limit is not None else None,
                             print_bytes=fl.as_bool("b"),
                             skip=int(skip) if skip is not None else None)
