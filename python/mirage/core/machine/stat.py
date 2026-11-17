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

import asyncio
import logging

from mirage.accessor.machine import MachineAccessor
from mirage.context.session_context import current_caller
from mirage.core.machine.constants import KINDS
from mirage.core.machine.utils import (
    checked,
    mount_base,
    remote,
    virtual_of,
)
from mirage.core.posix.errors import refusal
from mirage.core.posix.stat import parse_tree, tree_command
from mirage.core.posix.types import TreeRow
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.dates import epoch_to_iso
from mirage.utils.filetype import content_type_for_path
from mirage.utils.hidden import hidden_under, path_visible
from mirage.utils.path import norm
from mirage.utils.quote import single_quote

logger = logging.getLogger(__name__)


def row_stat(name: str, row: TreeRow) -> FileStat:
    """A machine's entry as ``stat`` renders it: its kind, mode, times
    and owners as the machine has them.

    Args:
        name (str): the entry's name.
        row (TreeRow): what find printed for it.
    """
    kind = KINDS.get(row.kind, FileType.FILE)
    modified = epoch_to_iso(row.mtime)
    regular = kind is FileType.FILE
    return FileStat(
        name=name,
        size=row.size if regular else None,
        modified=modified,
        fingerprint=modified,
        type=kind,
        content=content_type_for_path(name) if regular else None,
        mode=row.mode,
        uid=row.user,
        gid=row.group,
        atime=epoch_to_iso(row.atime),
    )


async def rows(
    accessor: MachineAccessor,
    machine: str,
    path: PathSpec,
    depth: int | None,
) -> list[TreeRow]:
    """What find on a machine prints for a path and what is below it,
    the path's own row first.

    Args:
        accessor (MachineAccessor): the mount's machines.
        machine (str): the machine's name.
        path (PathSpec): the path.
        depth (int | None): 0 for the path alone, 1 for its children,
            None for everything below.
    """
    out = await checked(
        accessor, machine, tree_command(remote(accessor, path), depth), path
    )
    found = parse_tree(out)
    if not found or found[0].rel:
        raise refusal(path, b"")
    return found


async def stat_row(
    accessor: MachineAccessor, machine: str, path: PathSpec
) -> TreeRow:
    """A path's row on one machine.

    Args:
        accessor (MachineAccessor): the mount's machines.
        machine (str): the machine's name.
        path (PathSpec): the path.
    """
    return (await rows(accessor, machine, path, 0))[0]


async def stat(
    accessor: MachineAccessor, machine: str, path: PathSpec
) -> FileStat:
    name = path.mount_path.rstrip("/").rsplit("/", 1)[-1] or "/"
    return row_stat(name, await stat_row(accessor, machine, path))


async def tree(
    accessor: MachineAccessor, machines: list[str], path: PathSpec
) -> dict[str, FileStat] | None:
    """Every entry under a directory on the machines that hold it, merged
    by path, from one find on each, where a walk sends a listing per
    directory. A machine whose find fails leaves the walk to readdir,
    which reports it.

    Args:
        accessor (MachineAccessor): the mount's machines.
        machines (list[str]): the machines holding the directory.
        path (PathSpec): the directory.
    """
    found = await asyncio.gather(
        *(rows(accessor, m, path, None) for m in machines),
        return_exceptions=True,
    )
    merged: dict[str, FileStat] = {}
    for listed in found:
        if isinstance(listed, BaseException):
            if not isinstance(listed, OSError):
                raise listed
            logger.debug(
                "%s: one find failed; walking it instead",
                path.virtual,
                exc_info=listed,
            )
            return None
        if listed[0].kind != "d":
            return None
        for row in listed[1:]:
            merged.setdefault(
                row.rel, row_stat(row.rel.rsplit("/", 1)[-1], row)
            )
    return merged


def restricted(path: PathSpec) -> bool:
    """Whether the running session hides anything in the mount ``path``
    is on, where a machine's own links may lead to a hidden name.

    Args:
        path (PathSpec): a path on the mount.
    """
    return hidden_under(current_caller().visibility, mount_base(path))


async def leads_to_hidden(accessor: MachineAccessor, path: PathSpec) -> bool:
    """Whether ``path`` resolves on a machine, through the machine's own
    links, to a name the running session hides: ``/tmp/public`` linked to
    a hidden ``/tmp/secret`` reads the secret on the machine, where
    Mirage checks only its own link table. Asked only of a session that
    hides something in the mount.

    Args:
        accessor (MachineAccessor): the mount's machines.
        path (PathSpec): the path an op names.
    """
    vis = current_caller().visibility
    if not hidden_under(vis, mount_base(path)):
        return False
    q = single_quote(remote(accessor, path))
    for machine in accessor.names():
        status, out, _ = await accessor.run(machine, f"readlink -f -- {q}")
        if status != 0:
            continue
        real = out.decode(errors="surrogateescape").rstrip("\n")
        seen = virtual_of(accessor, path, real)
        if (
            seen is not None
            and seen != norm(path.virtual)
            and not path_visible(vis, seen)
        ):
            return True
    return False
