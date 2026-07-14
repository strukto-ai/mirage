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
from mirage.commands.builtin.generic.crossmount.utils import (
    flat_scopes, relay, transfer_primitives)
from mirage.commands.builtin.generic.mv import mv as generic_mv
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.types import PathSpec


async def run_mv(scopes: list[PathSpec], flag_kwargs: dict,
                 dispatch: Callable) -> CrossResult:
    """Move operands that span mounts via the shared generic mv.

    Pure wiring: copy through the transfer primitives, then unlink the
    source on its own mount.

    Args:
        scopes (list[PathSpec]): Path operands in command-line order.
        flag_kwargs (dict): Flags parsed against the shared mv spec.
        dispatch (Callable): Workspace operation dispatcher.
    """
    p = functools.partial
    fl = FlagView(flag_kwargs, spec=SPECS["mv"])
    return await generic_mv(flat_scopes(scopes),
                            n=fl.as_bool("n"),
                            v=fl.as_bool("v"),
                            unlink=p(relay, dispatch, "unlink", None),
                            rmdir=p(relay, dispatch, "rmdir", None),
                            **transfer_primitives(dispatch))
