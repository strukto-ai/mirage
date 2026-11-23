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

from mirage.accessor.machine import MachineAccessor
from mirage.context.session_context import current_caller
from mirage.core.machine.constants import KINDS
from mirage.core.machine.types import Holder
from mirage.core.machine.utils import (
    leaf,
    machine_path,
    mount_prefix,
    run_checked,
    virtual_path,
)
from mirage.core.posix.errors import refusal
from mirage.core.posix.stat import parse_entries, tree_command
from mirage.core.posix.types import PosixEntry
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.dates import ms_to_rfc3339
from mirage.utils.filetype import content_type_for_path
from mirage.utils.hidden import hidden_under, path_visible
from mirage.utils.path import norm
from mirage.utils.quote import single_quote


def entry_stat(name: str, entry: PosixEntry) -> FileStat:
    """A machine's entry as ``stat`` renders it: its kind, mode, times
    and owners as the machine has them.

    Args:
        name (str): the entry's name.
        entry (PosixEntry): what find printed for it.
    """
    kind = KINDS.get(entry.kind, FileType.FILE)
    modified = ms_to_rfc3339(entry.mtime_ms)
    regular = kind is FileType.FILE
    return FileStat(
        name=name,
        size=entry.size if regular else None,
        modified=modified,
        fingerprint=modified,
        type=kind,
        content=content_type_for_path(name) if regular else None,
        mode=entry.mode,
        uid=entry.uid,
        gid=entry.gid,
        atime=ms_to_rfc3339(entry.atime_ms),
        nlink=entry.nlink,
        blocks=entry.blocks,
    )


def holder_stat(name: str, one: Holder) -> FileStat:
    """A machine's copy of a name as ``stat`` renders it, from the entry
    the machine was asked for.

    Args:
        name (str): the entry's name.
        one (Holder): the machine and the entry it reported.
    """
    assert one.entry is not None
    return entry_stat(name, one.entry)


async def entries(
    accessor: MachineAccessor,
    machine: str,
    path: PathSpec,
    depth: int | None,
) -> list[PosixEntry]:
    """What find on a machine prints for a path and what is below it,
    the path's own entry first.

    Args:
        accessor (MachineAccessor): the mount's machines.
        machine (str): the machine's name.
        path (PathSpec): the path.
        depth (int | None): 0 for the path alone, 1 for its children,
            None for everything below.
    """
    out = await run_checked(
        accessor,
        machine,
        tree_command(machine_path(accessor, path), depth),
        path,
    )
    found = parse_entries(out)
    if not found or found[0].rel:
        raise refusal(path, b"")
    return found


async def stat_entry(
    accessor: MachineAccessor, machine: str, path: PathSpec
) -> PosixEntry:
    """A path's entry on one machine.

    Args:
        accessor (MachineAccessor): the mount's machines.
        machine (str): the machine's name.
        path (PathSpec): the path.
    """
    return (await entries(accessor, machine, path, 0))[0]


async def stat(
    accessor: MachineAccessor, machine: str, path: PathSpec
) -> FileStat:
    return entry_stat(leaf(path), await stat_entry(accessor, machine, path))


def has_hides(path: PathSpec) -> bool:
    """Whether the running session hides anything in the mount ``path``
    is on, where a machine's own links may lead to a hidden name.

    Args:
        path (PathSpec): a path on the mount.
    """
    return hidden_under(current_caller().visibility, mount_prefix(path))


async def hidden_machines(
    accessor: MachineAccessor, path: PathSpec
) -> list[str]:
    """The machines on which ``path`` resolves, through the machine's own
    links, to a name the running session hides: ``/tmp/public`` linked to
    a hidden ``/tmp/secret`` reads the secret on the machine, where Mirage
    checks only its own link table. Each machine answers for itself, so
    another machine's visible files at the path stay; none is asked for a
    session that hides nothing in the mount.

    Args:
        accessor (MachineAccessor): the mount's machines.
        path (PathSpec): the path an op names.
    """
    if not hidden_under(current_caller().visibility, mount_prefix(path)):
        return []
    return [
        machine
        for machine in accessor.names()
        if await is_hidden_on(accessor, machine, path)
    ]


async def is_hidden_on(
    accessor: MachineAccessor, machine: str, path: PathSpec
) -> bool:
    """Whether ``path`` resolves on one machine, through that machine's
    own links, to a name the running session hides (``hidden_machines``);
    no for a session that hides nothing in the mount, which asks nothing.

    Args:
        accessor (MachineAccessor): the mount's machines.
        machine (str): the machine asked.
        path (PathSpec): the path an op names.
    """
    vis = current_caller().visibility
    if not hidden_under(vis, mount_prefix(path)):
        return False
    q = single_quote(machine_path(accessor, path))
    status, out, _ = await accessor.run(machine, f"readlink -f -- {q}")
    if status != 0:
        return False
    real = out.decode(errors="surrogateescape").rstrip("\n")
    seen = virtual_path(accessor, path, real)
    return (
        seen is not None
        and seen != norm(path.virtual)
        and not path_visible(vis, seen)
    )
