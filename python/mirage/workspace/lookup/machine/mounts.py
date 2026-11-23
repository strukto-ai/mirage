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

import logging
from collections.abc import Sequence

from mirage.core.machine.place import holders
from mirage.io.types import ByteSource
from mirage.runtime.binding import restricted_mounts_for
from mirage.runtime.machine import RemoteRuntime
from mirage.types import MountMode, PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.utils.path import CycleError, norm
from mirage.vfs.bin import BinViewVFS
from mirage.vfs.machine.machine import MachineVFS
from mirage.workspace.dispatcher.reader import NamespaceReader
from mirage.workspace.mount import MountRegistry
from mirage.workspace.mount.mount import MountEntry
from mirage.workspace.session import SessionState

logger = logging.getLogger(__name__)


def machine_mount(
    registry: MountRegistry, links: NamespaceReader, path: str, writes: bool
) -> MountEntry | None:
    """The machine mount showing ``path`` at the same path on its
    machines, with no other mount and no link of Mirage's own under the
    path; None for any other path, for one a write may not reach, and
    for one that walks through a link of Mirage's own, which the machine
    does not have. A name the ``/usr/bin`` view leaves to the mount
    beneath it is read from that mount, so ``/usr/bin/python3`` is the
    machine's own file where the machine's disk lies under the view.

    The link table is walked last: a path that is no machine's needs no
    look at it, and a folder of many links costs a walk of them all.

    Args:
        registry (MountRegistry): the workspace's mounts.
        links (NamespaceReader): the session's link table.
        path (str): an absolute virtual path.
        writes (bool): whether the mount must take writes.
    """
    entry = registry.try_mount_for(path)
    if (
        entry is not None
        and not writes
        and isinstance(entry.vfs, BinViewVFS)
        and entry.vfs.leaves(mount_key(path, entry.prefix))
    ):
        entry = registry.mount_beneath(entry, path)
    if entry is None or not isinstance(entry.vfs, MachineVFS):
        return None
    if norm(entry.vfs.config.root) != norm(entry.prefix):
        return None
    if writes and entry.mode is MountMode.READ:
        return None
    below = norm(path).rstrip("/") + "/"
    if any(
        m is not entry and norm(m.prefix).startswith(below)
        for m in registry.mounts()
    ):
        return None
    try:
        if norm(links.follow(norm(path))) != norm(path) or (
            links.link_stats_below(norm(path))
        ):
            return None
    except CycleError:
        logger.debug("%s: a link loop keeps it here", path, exc_info=True)
        return None
    return entry


def is_piped(stdin: ByteSource | None) -> bool:
    """Whether anything is piped in: the empty input ``xargs`` gives a
    command, as GNU's gives it ``/dev/null``, is none.

    Args:
        stdin (ByteSource | None): what is piped into the command.
    """
    return stdin is not None and stdin != b""


def _rules_restrict(
    session: SessionState, registry: MountRegistry, entries: list[MountEntry]
) -> bool:
    prefixes = [m.prefix for m in registry.mounts()]
    restricted = {norm(p) for p in restricted_mounts_for(session, prefixes)}
    return any(norm(e.prefix) in restricted for e in entries)


def machine_mounts(
    scopes: list[tuple[str, bool]],
    session: SessionState,
    registry: MountRegistry,
    links: NamespaceReader,
) -> list[MountEntry] | None:
    """The machine mount showing each path at its own path, in order;
    None when there is no path, any path is elsewhere, or the session's
    rules restrict one of those mounts.

    Args:
        scopes (list[tuple[str, bool]]): each absolute path, with whether
            the command may write it.
        session (SessionState): the session it runs in.
        registry (MountRegistry): the workspace's mounts and machines.
        links (NamespaceReader): the session's link table.
    """
    entries = [
        machine_mount(registry, links, p, writes) for p, writes in scopes
    ]
    if not scopes or None in entries:
        return None
    mounts = [e for e in entries if e is not None]
    if _rules_restrict(session, registry, mounts):
        return None
    return mounts


def only_machine(
    machines: Sequence[str], registry: MountRegistry
) -> RemoteRuntime | None:
    """The runtime that runs programs on the one machine named; None for
    none or several.

    Args:
        machines (Sequence[str]): the candidate machines.
        registry (MountRegistry): the workspace's mounts and machines.
    """
    if len(machines) != 1:
        return None
    return next(
        (
            e
            for e in registry.runtime_entries
            if isinstance(e, RemoteRuntime)
            and e.default_machine == machines[0]
        ),
        None,
    )


def mount_machines(entry: MountEntry, registry: MountRegistry) -> list[str]:
    """The machines a machine mount shows, by its config: the ones it
    names, else every machine the workspace runs programs on.

    Args:
        entry (MountEntry): a machine mount.
        registry (MountRegistry): the workspace's mounts and machines.
    """
    assert isinstance(entry.vfs, MachineVFS)
    named = entry.vfs.config.machines
    if named is not None:
        return list(named)
    return sorted(
        {
            e.default_machine
            for e in registry.runtime_entries
            if isinstance(e, RemoteRuntime)
        }
    )


async def machine_holding_all(
    scopes: list[tuple[str, bool]],
    session: SessionState,
    registry: MountRegistry,
    links: NamespaceReader,
    stdin: ByteSource | None,
    folder: str | None = None,
) -> RemoteRuntime | None:
    """The one machine holding every path, each its own at the same path
    on a machine mount the session may use, and the folder it runs from;
    None when any path is elsewhere, no one machine holds them all, or
    input is piped into a machine that takes none. A name several
    machines hold is no one machine's to answer for: Mirage shows it as
    one (``chosen``), so the command stays with Mirage. The folder a
    command only runs from may be on several.

    Args:
        scopes (list[tuple[str, bool]]): each absolute path, with whether
            the command may write it.
        session (SessionState): the session it runs in.
        registry (MountRegistry): the workspace's mounts and machines.
        links (NamespaceReader): the session's link table.
        stdin (ByteSource | None): what is piped into it.
        folder (str | None): the folder it runs from, which the machine
            must hold too; None for one that runs from ``/``.
    """
    stood = [] if folder is None else [(folder, False)]
    mounts = machine_mounts([*scopes, *stood], session, registry, links)
    if mounts is None or (
        await registry.policies.wants_for("pre_vfs", session.session_id)
    ):
        return None
    candidates: list[str] | None = None
    for at, ((path, _), entry) in enumerate(zip([*scopes, *stood], mounts)):
        assert isinstance(entry.vfs, MachineVFS)
        held = [
            one.machine
            for one in await holders(
                entry.vfs.accessor,
                path_on_mount(entry, path),
            )
        ]
        if len(held) > 1 and at < len(scopes):
            return None
        candidates = (
            held
            if candidates is None
            else [m for m in candidates if m in held]
        )
    runtime = only_machine(candidates or [], registry)
    if runtime is None:
        return None
    if is_piped(stdin) and not runtime.handle().takes_input:
        return None
    return runtime


def folder_machines(folder: str, registry: MountRegistry) -> list[str]:
    """The machines whose own files a folder is, by the mount showing it
    (``/srv/gpu`` over the gpu machine, ``/tmp`` over every machine);
    none for a folder in a store.

    Args:
        folder (str): the folder, an absolute virtual path.
        registry (MountRegistry): the workspace's mounts and machines.
    """
    entry = registry.try_mount_for(folder)
    if entry is None or not isinstance(entry.vfs, MachineVFS):
        return []
    return mount_machines(entry, registry)


def machine_names(registry: MountRegistry) -> set[str]:
    """The machines the workspace runs programs on, by their names under
    ``machines:``.

    Args:
        registry (MountRegistry): the workspace's mounts and machines.
    """
    return {
        e.default_machine
        for e in registry.runtime_entries
        if isinstance(e, RemoteRuntime)
    }


def several_machines(registry: MountRegistry) -> bool:
    """Whether the workspace runs programs on more than one machine, the
    only case where which machine a command runs on decides where a new
    file lands.

    Args:
        registry (MountRegistry): the workspace's mounts and machines.
    """
    return len(machine_names(registry)) > 1


def path_on_mount(entry: MountEntry, path: str) -> PathSpec:
    """A virtual path as its mount addresses it, the mount's own root
    included.

    Args:
        entry (MountEntry): the mount showing the path.
        path (str): an absolute virtual path on it.
    """
    return PathSpec.from_str_path(
        path, mount_key(path, entry.prefix.rstrip("/"))
    )
