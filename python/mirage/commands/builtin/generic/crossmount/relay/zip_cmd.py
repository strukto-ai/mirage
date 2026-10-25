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

from mirage.commands.builtin.generic.crossmount.types import CrossResult
from mirage.commands.builtin.generic.crossmount.utils import (
    flat_scopes,
    transfer_primitives,
)
from mirage.commands.builtin.generic.zip_cmd import parse_flags, zip_cmd
from mirage.commands.builtin.generic_bind.archive_io import relay_walk_of
from mirage.commands.builtin.generic_bind.files import dispatched_read_tree
from mirage.commands.builtin.utils.links import (
    link_location,
    link_view,
    mount_view,
    owed_names,
)
from mirage.commands.builtin.utils.operands import normalized_read
from mirage.commands.spec.types import FlagValue
from mirage.runtime.types import DispatchFn
from mirage.types import PathSpec
from mirage.workspace.files import Files


async def run_zip(
    scopes: list[PathSpec],
    flag_kwargs: dict[str, FlagValue],
    dispatch: DispatchFn,
    vfs: Files | None,
) -> CrossResult:
    """Run a zip whose archive and operands span mounts.

    Pure wiring: the shared generic plans on dispatch-relayed calls, so
    each operand is walked on the mount that owns it and the archive
    lands on its own. The scan still stops at a mount nested under an
    operand, exactly as it does when the whole line is on one mount.

    Args:
        scopes (list[PathSpec]): Path operands in command-line order;
            the archive is first.
        flag_kwargs (dict): Flags parsed against the shared zip spec.
        dispatch (DispatchFn): Workspace operation dispatcher.
        vfs (Files | None): The symlinks and mount boundaries the
            scan merges into each walk.
    """
    prim = transfer_primitives(dispatch)
    links = link_view(vfs)
    tree = (
        None
        if vfs is None
        else dispatched_read_tree(
            dispatch,
            mount_view(vfs),
            None if links is None else functools.partial(link_location, links),
            crossing=True,
        )
    )
    return await zip_cmd(
        flat_scopes(scopes),
        stream=normalized_read(prim["read_bytes"]),
        dispatch=dispatch,
        cwd=PathSpec.from_str_path("/"),
        stat=prim["stat"],
        walk=relay_walk_of(
            dispatch,
            functools.partial(owed_names, vfs),
            "zip",
            tree,
        ),
        flags=parse_flags(flag_kwargs),
        links=links,
        mounts=mount_view(vfs),
    )
