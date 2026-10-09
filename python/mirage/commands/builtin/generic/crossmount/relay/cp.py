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

from collections.abc import Awaitable
from dataclasses import replace
from functools import partial
from typing import Any, Callable

from mirage.commands.builtin.generic.cp import TransferLinks, parse_flags
from mirage.commands.builtin.generic.cp import cp_generic as generic_cp
from mirage.commands.builtin.generic.crossmount.types import CrossResult
from mirage.commands.builtin.generic.crossmount.utils import (
    flat_scopes,
    transfer_primitives,
)
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource
from mirage.runtime.types import DispatchFn
from mirage.types import FileStat, PathSpec, PrimitiveCopy
from mirage.view.types import LinkSubtree, MountView, NamespaceView


async def _own_filesystem(
    readdir: Callable[..., Awaitable[list[str]]],
    mounts: MountView,
    starts: set[str],
    path: PathSpec,
    **kwargs: Any,
) -> list[str]:
    """List a directory for ``cp -x``: a mount root below the operands
    is empty, so the copy makes the mount point and reads nothing on the
    other filesystem, as GNU's --one-file-system does.

    Args:
        readdir (Callable): the relayed readdir.
        mounts (MountView): the mount boundaries.
        starts (set[str]): the operands, whose own mounts are copied.
        path (PathSpec): the directory to list.
        **kwargs: forwarded untouched.
    """
    if path.virtual not in starts and mounts.is_root(path.virtual):
        return []
    return await readdir(path, **kwargs)


def _own_links(
    subtree: LinkSubtree,
    mounts: MountView,
    starts: set[str],
    directory: str,
) -> list[tuple[str, FileStat]]:
    """The links below a directory that ``cp -x`` reaches: none under a
    mount root its listing leaves empty, at or below the directory.

    Args:
        subtree (LinkSubtree): the namespace's link walk.
        mounts (MountView): the mount boundaries.
        starts (set[str]): the operands, whose own mounts are copied.
        directory (str): the copied directory.
    """
    below = directory.rstrip("/") + "/"
    rows = []
    for virtual, stat in subtree(directory):
        root = mounts.root_of(virtual).rstrip("/") or "/"
        if root in starts or not f"{root}/".startswith(below):
            rows.append((virtual, stat))
    return rows


async def run_cp(
    scopes: list[PathSpec],
    flag_kwargs: dict[str, FlagValue],
    dispatch: DispatchFn,
    storage_key: Callable[[PathSpec], str] | None = None,
    ns: NamespaceView | None = None,
    cwd: str = "/",
    stdin: ByteSource | None = None,
) -> CrossResult:
    """Copy operands that span mounts via the shared generic cp.

    Pure wiring: the generic runs in its primitive mode (no native copy),
    reading from the source mount and writing to the destination mount
    through dispatch-relayed primitives.

    Args:
        scopes (list[PathSpec]): Path operands in command-line order.
        flag_kwargs (dict): Flags parsed against the shared cp spec.
        dispatch (DispatchFn): Workspace operation dispatcher.
        storage_key (Callable | None): Maps an operand to its storage
            identity so two prefixes over one store compare equal.
        ns (NamespaceView | None): The namespace's links, which a copy
            that does not follow them recreates by name.
        cwd (str): The working directory a typed link source resolves
            against.
        stdin (ByteSource | None): where ``-i`` reads its answers.
    """
    fl = FlagView(flag_kwargs, spec=SPECS["cp"])
    primitives = transfer_primitives(dispatch)
    links = ns.links if ns is not None else None
    if fl.as_bool("one_file_system") and ns is not None and ns.mounts:
        starts = {s.virtual for s in scopes}
        primitives["readdir"] = partial(
            _own_filesystem, primitives["readdir"], ns.mounts, starts
        )
        if links is not None:
            links = replace(
                links,
                subtree=partial(_own_links, links.subtree, ns.mounts, starts),
            )
    strategy = PrimitiveCopy(
        read_bytes=primitives["read_bytes"],
        write=primitives["write"],
        mkdir=primitives["mkdir"],
        readdir=primitives["readdir"],
    )
    return await generic_cp(
        flat_scopes(scopes),
        stat=primitives["stat"],
        strategy=strategy,
        flags=parse_flags(fl),
        backend_key=storage_key,
        copies=(
            TransferLinks(
                links=links,
                dispatch=dispatch,
                cwd=cwd,
                relay=strategy,
                relay_stat=primitives["stat"],
                visibility=ns.visibility if ns is not None else None,
            )
            if links is not None
            else None
        ),
        stdin=stdin,
    )
