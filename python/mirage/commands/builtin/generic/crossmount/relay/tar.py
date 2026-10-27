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
from mirage.commands.builtin.generic.tar.tar import parse_flags, tar
from mirage.commands.builtin.generic_bind.archive_io import (
    relay_is_dir_of,
    relay_walk_of,
)
from mirage.commands.builtin.generic_bind.files import dispatched_read_tree
from mirage.commands.builtin.utils.links import (
    link_location,
    link_view,
    mount_view,
    owed_names,
)
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource
from mirage.runtime.types import DispatchFn
from mirage.types import PathSpec
from mirage.workspace.files import Files


async def run_tar(
    scopes: list[PathSpec],
    text_args: list[str],
    flag_kwargs: dict[str, FlagValue],
    dispatch: DispatchFn,
    vfs: Files | None,
    cwd: str,
    stdin: ByteSource | None = None,
) -> CrossResult:
    """Run a tar whose archive, operands and -C destination span mounts.

    Pure wiring: the shared generic runs on dispatch-relayed calls, so
    the archive is read from or written to its mount, every extracted
    path lands on whichever mount owns it, and each -c operand is walked
    on the mount that owns it. The create scan still stops at a mount
    nested under an operand, exactly as it does on one mount.

    Args:
        scopes (list[PathSpec]): Path operands in command-line order.
        text_args (list[str]): The -t/-x member selectors, as typed.
        flag_kwargs (dict): Flags parsed against the shared tar spec,
            with path-valued flags retaining their PathSpec metadata.
        dispatch (DispatchFn): Workspace operation dispatcher.
        vfs (Files | None): The symlinks and mount boundaries the
            create scan merges into each walk.
        cwd (str): The session's working directory, which relative names
            and an extraction without -C resolve against.
        stdin (ByteSource | None): The archive input when ``-f -`` is used.
    """
    parsed = parse_flags(flag_kwargs)
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
    operands = scopes if parsed.create and parsed.archive else []
    return await tar(
        flat_scopes(operands),
        list(text_args),
        parsed,
        stream=prim["read_stream"],
        stat=prim["stat"],
        walk=relay_walk_of(
            dispatch,
            functools.partial(owed_names, vfs),
            "tar",
            tree,
        ),
        is_dir=relay_is_dir_of(dispatch),
        dispatch=dispatch,
        cwd=PathSpec.from_str_path(cwd),
        stdin=stdin,
        links=links,
        mounts=mount_view(vfs),
        relay=True,
    )
