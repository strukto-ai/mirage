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

from mirage.core.machine.place import chosen, holders, new_name_machine
from mirage.core.machine.types import Holder
from mirage.core.machine.utils import folder_of
from mirage.runtime.machine import RemoteRuntime
from mirage.utils.path import norm, parent
from mirage.vfs.machine.machine import MachineVFS
from mirage.workspace.dispatcher.reader import NamespaceReader
from mirage.workspace.lookup.machine.mounts import (
    machine_mounts,
    only_machine,
    path_on_mount,
)
from mirage.workspace.lookup.types import ExternalTarget
from mirage.workspace.mount import MountRegistry
from mirage.workspace.session import SessionState

logger = logging.getLogger(__name__)


async def link_machine(
    made: Sequence[tuple[str, str]],
    symbolic: bool,
    session: SessionState,
    registry: MountRegistry,
    links: NamespaceReader,
    absolute: bool,
) -> ExternalTarget | None:
    """The machine an ``ln`` runs on whole, when one machine can make
    every link (``_linking_machine``): the machine makes the link, so its
    programs follow it, where Mirage's link table holds links only
    Mirage sees.

    It runs from the session's folder when the machine holds that folder.
    From any other folder it runs from ``/`` when every path it names is
    absolute, and stays with Mirage otherwise, since the machine could
    not resolve a relative name.

    Args:
        made (Sequence[tuple[str, str]]): each link's absolute path and
            its target, resolved as the link will resolve it.
        symbolic (bool): whether the links are symbolic.
        session (SessionState): the session it runs in.
        registry (MountRegistry): the workspace's mounts and machines.
        links (NamespaceReader): the session's link table.
        absolute (bool): whether every path the command names, that the
            folder it runs from could change, is typed absolute.
    """
    if not made:
        return None
    runtime = await _linking_machine(made, symbolic, session, registry, links)
    if runtime is None or not await runtime.handle().has_program("ln"):
        return None
    cwd = norm(session.cwd)
    if cwd == "/" or await _holds_folder(
        runtime, cwd, session, registry, links
    ):
        return ExternalTarget(runtime)
    return ExternalTarget(runtime, "/") if absolute else None


async def _holds_folder(
    runtime: RemoteRuntime,
    folder: str,
    session: SessionState,
    registry: MountRegistry,
    links: NamespaceReader,
) -> bool:
    """Whether a machine holds a folder at its own path, so a program
    there can run from it.

    Args:
        runtime (RemoteRuntime): the machine's runtime.
        folder (str): the folder, an absolute virtual path.
        session (SessionState): the session.
        registry (MountRegistry): the workspace's mounts and machines.
        links (NamespaceReader): the session's link table.
    """
    mounts = machine_mounts([(folder, False)], session, registry, links)
    if mounts is None:
        return False
    entry = mounts[0]
    assert isinstance(entry.vfs, MachineVFS)
    held = await holders(entry.vfs.accessor, path_on_mount(entry, folder))
    return any(
        one.machine == runtime.default_machine and _may_be_folder(one)
        for one in held
    )


def _may_be_folder(one: Holder) -> bool:
    """Whether a machine holds a folder at a name as far as is known: a
    mount on one machine asks nothing, so its machine answers for itself.

    Args:
        one (Holder): the machine and what it reports for the name.
    """
    return one.is_folder or one.entry is None


async def _linking_machine(
    made: Sequence[tuple[str, str]],
    symbolic: bool,
    session: SessionState,
    registry: MountRegistry,
    links: NamespaceReader,
) -> RemoteRuntime | None:
    """The one machine that makes every link, when one can. A link is
    made on the machine holding its target, the copy shown of it
    (``chosen``), so the link leads where Mirage reads the target; a
    symbolic link to a name no machine holds is a new name like any
    other (``new_name_machine``). That machine must hold the link's
    folder, whose copy shown is a folder, and no other machine may hold
    the link's name, which Mirage's own ``ln`` then answers for.

    None when a path is off a machine mount, the session's rules or a
    coded file policy speak for the mount, a hard link's target is
    missing, or the links land on different machines: the links are then
    Mirage's own.

    Args:
        made (Sequence[tuple[str, str]]): each link's absolute path and
            its target, resolved as the link will resolve it.
        symbolic (bool): whether the links are symbolic.
        session (SessionState): the session it runs in.
        registry (MountRegistry): the workspace's mounts and machines.
        links (NamespaceReader): the session's link table.
    """
    scopes = [
        *((parent(link), True) for link, _ in made),
        *((target, False) for _, target in made),
    ]
    mounts = machine_mounts(scopes, session, registry, links)
    if mounts is None or (
        await registry.policies.wants_for("pre_vfs", session.session_id)
    ):
        return None
    machines: set[str] = set()
    for at, (link, target) in enumerate(made):
        folder, aimed = mounts[at], mounts[len(made) + at]
        assert isinstance(folder.vfs, MachineVFS)
        assert isinstance(aimed.vfs, MachineVFS)
        spec = path_on_mount(folder, link)
        held = await holders(aimed.vfs.accessor, path_on_mount(aimed, target))
        if held:
            machine = chosen(aimed.vfs.accessor, held).machine
        elif symbolic:
            try:
                machine = await new_name_machine(folder.vfs.accessor, spec)
            except NotADirectoryError:
                logger.debug("%s: its folder is a file", link, exc_info=True)
                return None
        else:
            return None
        above = await holders(folder.vfs.accessor, folder_of(spec))
        if not above or not _may_be_folder(chosen(folder.vfs.accessor, above)):
            return None
        if not any(
            one.machine == machine and _may_be_folder(one) for one in above
        ):
            return None
        if len(above) > 1 and any(
            one.machine != machine
            for one in await holders(folder.vfs.accessor, spec)
        ):
            return None
        machines.add(machine)
    return only_machine(sorted(machines), registry)
