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
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource
from mirage.ops.types import NamespaceView
from mirage.runtime.types import DispatchFn
from mirage.types import PathSpec


async def run_tar(
    scopes: list[PathSpec],
    text_args: list[str],
    flag_kwargs: dict[str, FlagValue],
    dispatch: DispatchFn,
    ns: NamespaceView | None,
    stdin: ByteSource | None = None,
) -> CrossResult:
    """Run a tar whose archive, operands and -C destination span mounts.

    Pure wiring: the shared generic runs on dispatch-relayed doors, so
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
        ns (NamespaceView | None): The symlinks and mount boundaries the
            create scan merges into each walk.
        stdin (ByteSource | None): The archive input when ``-f -`` is used.
    """
    parsed = parse_flags(flag_kwargs)
    prim = transfer_primitives(dispatch)
    archive = parsed.archive
    directories = list(parsed.directories)
    operands = scopes if parsed.create and archive else []
    return await tar(
        flat_scopes(operands),
        read_bytes=prim["read_bytes"],
        write_bytes=prim["write"],
        mkdir_fn=prim["mkdir"],
        stat=prim["stat"],
        walk=relay_walk_of(
            dispatch, ns.child_mounts if ns is not None else None
        ),
        is_dir=relay_is_dir_of(dispatch),
        selectors=list(text_args),
        c=parsed.create,
        x=parsed.extract,
        t=parsed.list_only,
        z=parsed.gzip,
        j=parsed.bzip2,
        J=parsed.xz,
        v=parsed.verbose,
        h=parsed.deref,
        to_stdout=parsed.to_stdout,
        f=archive,
        C=directories or None,
        strip_components=parsed.strip_components,
        exclude=parsed.exclude,
        one_file_system=parsed.one_file_system,
        links=ns.links if ns is not None else None,
        mounts=ns.mounts if ns is not None else None,
        relay=True,
        stdin=stdin,
    )
