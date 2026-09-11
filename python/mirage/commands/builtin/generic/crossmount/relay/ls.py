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

from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.crossmount.types import CrossResult
from mirage.commands.builtin.generic.crossmount.utils import flat_scopes, relay
from mirage.commands.builtin.generic.ls import Stat
from mirage.commands.builtin.generic.ls import ls as generic_ls
from mirage.commands.builtin.generic.ls import ls_options
from mirage.commands.builtin.generic_bind.adapter import overlaid_stat
from mirage.commands.builtin.utils.identity import identity_from
from mirage.commands.spec.types import FlagValue
from mirage.ops.types import NamespaceView, SessionView
from mirage.runtime.types import DispatchFn
from mirage.types import FileStat, PathSpec
from mirage.utils.path import gnu_basename


async def relayed_readdir(dispatch: DispatchFn, path: PathSpec,
                          index: IndexCacheStore | None) -> list[str]:
    """Read one directory on the mount that owns it.

    The index argument is accepted and dropped. A cache index belongs to
    one mount, so the caller's index cannot answer for the mount this
    path routes to; the relayed op consults its own mount's index.

    Args:
        dispatch (DispatchFn): Workspace operation dispatcher.
        path (PathSpec): Directory addressed by its full virtual path.
        index (IndexCacheStore | None): Unused, see above.
    """
    names: list[str] = await relay(dispatch, "readdir", path)
    return names


async def relayed_stat(dispatch: DispatchFn, path: PathSpec,
                       index: IndexCacheStore | None) -> FileStat:
    """Stat one entry on the mount that owns it, named by its own path.

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
        index (IndexCacheStore | None): Unused, see ``relayed_readdir``.
    """
    info: FileStat = await relay(dispatch, "stat", path)
    name = gnu_basename(path.virtual)
    if name in ("", "/") or info.name == name:
        return info
    return info.model_copy(update={"name": name})


async def run_ls(scopes: list[PathSpec],
                 flag_kwargs: dict[str, FlagValue],
                 dispatch: DispatchFn,
                 ns: NamespaceView | None,
                 session_view: SessionView | None = None) -> CrossResult:
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
        ns (NamespaceView | None): Name-plane facts no backend can see.
            The attr overlay matters most here: without it a relayed row
            would report the raw backend mode and silently lose a chmod
            the namespace holds. Every fact but ``mounts``, which names
            the boundaries a walk's readdir cannot cross: this one's
            does cross them, so the relay descends a nested mount
            itself, and it has to, because nothing runs behind a relay
            to contribute that group the way the fan-out does for a
            single-mount run.
        session_view (SessionView | None): The session plane's door,
            for the profile the group column renders.
    """
    p = functools.partial
    stat_fn: Stat = p(relayed_stat, dispatch)
    overlay = ns.stat_overlay if ns is not None else None
    if overlay is not None:
        stat_fn = p(overlaid_stat, stat_fn, overlay)
    return await generic_ls(
        flat_scopes(scopes),
        readdir=p(relayed_readdir, dispatch),
        stat=stat_fn,
        links=ns.links if ns is not None else None,
        child_mounts=(ns.child_mounts if ns is not None else None),
        identity=identity_from(ns, session_view),
        **ls_options(flag_kwargs))
