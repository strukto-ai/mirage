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
    parent_followed,
    transfer_links_of,
    transfer_primitives,
)
from mirage.commands.builtin.generic.mv import mv_generic as generic_mv
from mirage.commands.builtin.generic.mv import parse_flags
from mirage.commands.builtin.generic_bind.files import (
    dispatched_call,
    refuse_reveal,
)
from mirage.commands.builtin.utils.links import link_view, mount_view
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource
from mirage.runtime.types import DispatchFn
from mirage.types import CheckFn, PathSpec, PrimitiveMove
from mirage.view.types import MountView
from mirage.workspace.dispatcher.reader import NamespaceReader
from mirage.workspace.files import Files, reader_of


def _renames(
    reader: NamespaceReader, mounts: MountView, src: PathSpec, target: PathSpec
) -> bool:
    """Whether a source moves by a rename: it and its target sit on one
    mount once the links above both are followed, that mount's store
    renames, and no mount sits below either, which a rename (or
    ``--exchange``'s swap) would leave where it is.

    Args:
        reader (NamespaceReader): the links as the session sees them.
        mounts (MountView): the mount boundaries.
        src (PathSpec): the source.
        target (PathSpec): where it goes.
    """
    here = parent_followed(reader, src.virtual)
    there = parent_followed(reader, target.virtual)
    return (
        mounts.root_of(here) == mounts.root_of(there)
        and mounts.answers is not None
        and mounts.answers(here, "rename")
        and not (mounts.descendants(here) or mounts.descendants(there))
    )


async def run_mv(
    scopes: list[PathSpec],
    flag_kwargs: dict[str, FlagValue],
    dispatch: DispatchFn,
    storage_key: Callable[[PathSpec], str] | None = None,
    vfs: Files | None = None,
    stdin: ByteSource | None = None,
    check_unlink: CheckFn | None = None,
) -> CrossResult:
    """Move operands that span mounts via the shared generic mv.

    Pure wiring: a source that stays on its mount renames there; any
    other is copied through the transfer primitives, then unlinked on its
    own mount.

    Args:
        scopes (list[PathSpec]): Path operands in command-line order.
        flag_kwargs (dict): Flags parsed against the shared mv spec.
        dispatch (DispatchFn): Workspace operation dispatcher.
        storage_key (Callable | None): Maps an operand to its storage
            identity. Without it a move between two prefixes over one
            store would copy the object onto itself and then unlink the
            source, destroying it.
        vfs (Files | None): Namespace facts for link operands.
        stdin (ByteSource | None): where ``-i`` reads its answers.
        check_unlink (CheckFn | None): Refuses a source whose mount
            cannot condition the delete, before anything is copied.
    """
    links = link_view(vfs)
    mounts = mount_view(vfs)
    p = functools.partial
    fl = FlagView(flag_kwargs, spec=SPECS["mv"])
    primitives = transfer_primitives(dispatch)
    return await generic_mv(
        flat_scopes(scopes),
        stat=primitives["stat"],
        strategy=PrimitiveMove(
            read=primitives["read_stream"],
            write=primitives["write"],
            mkdir=primitives["mkdir"],
            readdir=primitives["readdir"],
            unlink=p(dispatched_call, dispatch, "unlink"),
            rmdir=p(dispatched_call, dispatch, "rmdir"),
            check_unlink=check_unlink,
            copy=primitives["copy"],
        ),
        flags=parse_flags(fl),
        backend_key=storage_key,
        guard=refuse_reveal,
        copies=(
            transfer_links_of(links, dispatch, "/")
            if links is not None
            else None
        ),
        stdin=stdin,
        mount_root=(mounts.is_root if mounts is not None else None),
        dispatch=dispatch,
        renames=(
            functools.partial(_renames, reader_of(vfs), mounts)
            if vfs is not None and mounts is not None
            else None
        ),
    )
