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
from mirage.errors.constants import FS_ERRORS
from mirage.io.types import ByteSource
from mirage.runtime.machine import RemoteRuntime
from mirage.runtime.types import DispatchFn
from mirage.types import PathSpec
from mirage.vfs.machine.machine import MachineVFS
from mirage.workspace.dispatcher.reader import NamespaceReader
from mirage.workspace.lookup.machine.mounts import (
    is_piped,
    machine_mounts,
    only_machine,
    path_on_mount,
)
from mirage.workspace.lookup.machine.search import nearest_machine
from mirage.workspace.mount import MountRegistry
from mirage.workspace.session import SessionState

logger = logging.getLogger(__name__)


async def program_machine(
    path: str,
    session: SessionState,
    registry: MountRegistry,
    links: NamespaceReader,
    dispatch: DispatchFn,
    stdin: ByteSource | None,
    named: str | None = None,
    paths: Sequence[str] = (),
    cwd: str | None = None,
) -> RemoteRuntime | None:
    """The machine a program named by its path runs on, when the file is
    a machine's own at that path: the ``venv/bin/python`` a machine's
    ``python -m venv`` made in /tmp runs there, as bash runs it, where
    Mirage would read the binary and refuse it. A file several machines
    hold runs on the one the line names when it holds the file, else on
    the one search order picks among them (``nearest_machine``), and is
    never read into Mirage. The path is asked of the dispatcher first, so
    a hidden or refused path stays with Mirage, which words the refusal.

    Args:
        path (str): the head word, as typed.
        session (SessionState): the session it runs in.
        registry (MountRegistry): the workspace's mounts and machines.
        links (NamespaceReader): the session's link table.
        dispatch (DispatchFn): op dispatcher, which applies the session's
            hides and policies to the path.
        stdin (ByteSource | None): what is piped into it.
        named (str | None): the machine the line names.
        paths (Sequence[str]): the absolute paths the command names.
        cwd (str | None): the folder it runs from; None for the
            session's own.
    """
    here = session.cwd if cwd is None else cwd
    spec = PathSpec.from_str_path(path, cwd=session.cwd)
    mounts = machine_mounts([(spec.virtual, False)], session, registry, links)
    if mounts is None:
        return None
    try:
        await dispatch("stat", spec)
    except FS_ERRORS:
        logger.debug("%s: not run on its machine", path, exc_info=True)
        return None
    if await registry.policies.wants_for("pre_vfs", session.session_id):
        return None
    entry = mounts[0]
    assert isinstance(entry.vfs, MachineVFS)
    held = [
        one.machine
        for one in await holders(
            entry.vfs.accessor, path_on_mount(entry, spec.virtual)
        )
    ]
    machine = (
        named
        if named in held
        else await nearest_machine(held, here, paths, session, registry)
    )
    runtime = only_machine([] if machine is None else [machine], registry)
    if runtime is None:
        return None
    if is_piped(stdin) and not runtime.handle().takes_input:
        return None
    return runtime
