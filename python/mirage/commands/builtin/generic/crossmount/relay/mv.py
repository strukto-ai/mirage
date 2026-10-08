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
    flat_scopes,
    relay,
    transfer_links_of,
    transfer_primitives,
)
from mirage.commands.builtin.generic.mv import mv_generic as generic_mv
from mirage.commands.builtin.generic.mv import parse_flags
from mirage.commands.builtin.generic_bind.adapter import refuse_reveal
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource
from mirage.runtime.types import DispatchFn
from mirage.types import CheckFn, PathSpec, PrimitiveMove
from mirage.view.types import NamespaceView


async def run_mv(
    scopes: list[PathSpec],
    flag_kwargs: dict[str, FlagValue],
    dispatch: DispatchFn,
    storage_key: Callable[[PathSpec], str] | None = None,
    ns: NamespaceView | None = None,
    stdin: ByteSource | None = None,
    check_unlink: CheckFn | None = None,
) -> CrossResult:
    """Move operands that span mounts via the shared generic mv.

    Pure wiring: copy through the transfer primitives, then unlink the
    source on its own mount.

    Args:
        scopes (list[PathSpec]): Path operands in command-line order.
        flag_kwargs (dict): Flags parsed against the shared mv spec.
        dispatch (DispatchFn): Workspace operation dispatcher.
        storage_key (Callable | None): Maps an operand to its storage
            identity. Without it a move between two prefixes over one
            store would copy the object onto itself and then unlink the
            source, destroying it.
        ns (NamespaceView | None): Namespace facts for link operands.
        stdin (ByteSource | None): where ``-i`` reads its answers.
        check_unlink (CheckFn | None): Refuses a source whose mount
            cannot condition the delete, before anything is copied.
    """
    p = functools.partial
    fl = FlagView(flag_kwargs, spec=SPECS["mv"])
    primitives = transfer_primitives(dispatch)
    return await generic_mv(
        flat_scopes(scopes),
        stat=primitives["stat"],
        strategy=PrimitiveMove(
            read_bytes=primitives["read_bytes"],
            write=primitives["write"],
            mkdir=primitives["mkdir"],
            readdir=primitives["readdir"],
            unlink=p(relay, dispatch, "unlink"),
            rmdir=p(relay, dispatch, "rmdir"),
            check_unlink=check_unlink,
        ),
        flags=parse_flags(fl),
        backend_key=storage_key,
        guard=refuse_reveal,
        copies=(
            transfer_links_of(ns.links, dispatch, "/", ns.visibility)
            if ns is not None and ns.links is not None
            else None
        ),
        stdin=stdin,
    )
