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
from mirage.commands.builtin.generic.crossmount.utils import flat_scopes
from mirage.commands.builtin.generic.ls import Stat, ls_options
from mirage.commands.builtin.generic.ls import ls as generic_ls
from mirage.commands.builtin.generic_bind.files import dispatched_call
from mirage.commands.builtin.utils.identity import identity_from
from mirage.commands.builtin.utils.links import link_view, mount_view
from mirage.commands.spec.types import FlagValue
from mirage.runtime.types import DispatchFn
from mirage.types import FileStat, PathSpec
from mirage.utils.path import gnu_basename
from mirage.view.types import SessionView
from mirage.workspace.files import Files


async def relayed_readdir(dispatch: DispatchFn, path: PathSpec) -> list[str]:
    """Read one directory on the mount that owns it, which consults its
    own index. The dispatcher's listing names the links among the
    entries.

    Args:
        dispatch (DispatchFn): Workspace operation dispatcher.
        path (PathSpec): Directory addressed by its full virtual path.
    """
    names: list[str] = await dispatched_call(dispatch, "readdir", path)
    return names


async def relayed_stat(dispatch: DispatchFn, path: PathSpec) -> FileStat:
    """lstat one entry on the mount that owns it, named by its own path.

    readdir supplies the parent's names and stat supplies the target's
    facts, and relaying lets the two land on different mounts: statting
    a nested mount's root reaches a backend that calls its own root
    ``/``, not the name the parent listing knows it by. The single-mount
    path never sees this because parent and child are one backend. The
    name has to win from the parent's side, or ``-R`` descends into
    ``parent + "/"``, which is the parent again.

    Args:
        dispatch (DispatchFn): Workspace operation dispatcher.
        path (PathSpec): Entry addressed by its full virtual path.
    """
    info: FileStat = await dispatched_call(
        dispatch, "stat", path, nofollow=True
    )
    name = gnu_basename(path.virtual)
    if name in ("", "/") or info.name == name:
        return info
    return info.model_copy(update={"name": name})


async def run_ls(
    scopes: list[PathSpec],
    flag_kwargs: dict[str, FlagValue],
    dispatch: DispatchFn,
    vfs: Files | None,
    session_view: SessionView | None = None,
) -> CrossResult:
    """List operands spanning mounts through the shared generic ls.

    ls relays rather than fans out because its layout is decided across
    all operands at once: GNU prints non-directory operands first as one
    globally sorted block, then names each directory in sorted order,
    and heads them only when the line carried more than one operand. A
    per-operand run sees one operand and cannot know any of that, so the
    generic has to see the whole line -- which it can, because readdir
    and stat route per path.

    Args:
        scopes (list[PathSpec]): Path operands in command-line order.
        flag_kwargs (dict): Flags parsed against the shared ls spec.
        dispatch (DispatchFn): Workspace operation dispatcher.
        vfs (Files | None): The session's files, whose links a listing
            marks. The dispatcher's stat carries the attribute overlay
            and its listing the mounts below, so the relay descends a
            nested mount itself, as nothing runs behind a relay to
            contribute that group the way the fan-out does for a
            single-mount run; ``-R`` charges each entry to the mount
            serving it, at that mount's ``walk_limit``.
        session_view (SessionView | None): The session view,
            for the profile the group column renders.
    """
    p = functools.partial
    stat_fn: Stat = p(relayed_stat, dispatch)
    links = link_view(vfs)
    return await generic_ls(
        flat_scopes(scopes),
        readdir=p(relayed_readdir, dispatch),
        stat=stat_fn,
        links=links,
        mounts=mount_view(vfs, crossing=True),
        identity=identity_from(session_view),
        **ls_options(flag_kwargs),
    )
