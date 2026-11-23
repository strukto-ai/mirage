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

from mirage.runtime.machine import RemoteRuntime
from mirage.runtime.types import DispatchFn, RouteDecision, RuntimeIdentity
from mirage.types import PathSpec
from mirage.utils.glob_walk import unmark_globs
from mirage.utils.path import norm
from mirage.workspace.expand.classify.heuristic import classify_word
from mirage.workspace.frame import PipeWriter
from mirage.workspace.lookup.lookup import program_head, program_runtime
from mirage.workspace.lookup.machine.command import program_machine
from mirage.workspace.lookup.machine.mounts import (
    folder_machines,
    several_machines,
)
from mirage.workspace.lookup.machine.search import (
    folder_holders,
    searched_machine,
)
from mirage.workspace.mount import MountRegistry
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.session import SessionState


async def preferred_machine(
    session: SessionState,
    registry: MountRegistry,
    routing: RouteDecision[RuntimeIdentity] | None,
    fed_by: PipeWriter | None,
    namespace: Namespace,
    dispatch: DispatchFn,
    asked: dict[str, list[str]],
) -> str | None:
    """The machine a command Mirage runs itself is about
    (``Caller.preferred_machine``): the one the line names, else the one
    whose program writes the pipe it reads, else the one machine holding
    its folder, which a mount several machines show asks them
    (``folder_holders``); None when nothing says, and in a workspace
    that runs programs on one machine, where nothing is to choose.

    A pipe's writer is placed once for the pipe, so a reader that moves
    (``gen | (cd /srv; tee log)``) or runs many commands asks no more.

    Args:
        session (SessionState): the session it runs in.
        registry (MountRegistry): the workspace's mounts and machines.
        routing (RouteDecision | None): the line's placement.
        fed_by (PipeWriter | None): the program writing the pipe the
            command reads.
        namespace (Namespace): the link table a writer's path is read
            through.
        dispatch (DispatchFn): op dispatcher, which a writer's path is
            asked of.
        asked (dict[str, list[str]]): the machines the line found
            holding its folders (``ExecutionFrame.folder_holders``).
    """
    if routing is None or not several_machines(registry):
        return None
    if routing.machine is not None:
        return routing.machine
    if fed_by is not None and not fed_by.placed:
        fed_by.machine = await _writer_machine(
            fed_by, session, registry, routing, namespace, dispatch
        )
        fed_by.placed = True
    if fed_by is not None and fed_by.machine is not None:
        return fed_by.machine
    held = await folder_holders(session.cwd, session, registry, asked)
    return held[0] if len(held) == 1 else None


def asks_machines(
    session: SessionState,
    registry: MountRegistry,
    routing: RouteDecision[RuntimeIdentity] | None,
    fed_by: PipeWriter | None,
    asked: dict[str, list[str]],
) -> bool:
    """Whether ``preferred_machine`` may ask a machine for its answer:
    to place a pipe's writer not placed yet, or to find who holds a
    folder a mount several machines show that the line has not asked
    about. The command is then admitted first, so a refused one never
    reaches a machine.

    Args:
        session (SessionState): the session it runs in.
        registry (MountRegistry): the workspace's mounts and machines.
        routing (RouteDecision | None): the line's placement.
        fed_by (PipeWriter | None): the program writing the pipe the
            command reads.
        asked (dict[str, list[str]]): the machines the line found
            holding its folders (``ExecutionFrame.folder_holders``).
    """
    if routing is None or routing.machine is not None:
        return False
    if not several_machines(registry):
        return False
    if fed_by is not None and not fed_by.placed:
        return True
    if fed_by is not None and fed_by.machine is not None:
        return False
    folder = session.cwd
    return folder not in asked and len(folder_machines(folder, registry)) > 1


def _writer_paths(fed_by: PipeWriter, registry: MountRegistry) -> list[str]:
    """The absolute paths a pipe's writer names, read as its run reads
    its words (``classify_word``), so the writer is placed where it runs
    (``gen /srv/gpu/in | tee log``); a word only known when it runs names
    none.

    Args:
        fed_by (PipeWriter): the pipe's writer.
        registry (MountRegistry): the workspace's mounts and machines.
    """
    read = (
        classify_word(word, registry, fed_by.cwd)
        for word in fed_by.words[1:]
        if word is not None
    )
    return [unmark_globs(w.virtual) for w in read if isinstance(w, PathSpec)]


async def _writer_machine(
    fed_by: PipeWriter,
    session: SessionState,
    registry: MountRegistry,
    routing: RouteDecision[RuntimeIdentity],
    namespace: Namespace,
    dispatch: DispatchFn,
) -> str | None:
    """The machine a pipe's writer runs on, placed as it runs, from the
    folder its pipeline started in: by its words, through the wrappers
    Mirage runs (``nice gen | tee log``), and one named by its path on
    the machine holding that file (``nice /tmp/tool | tee log``). None
    for a program Mirage runs itself, and for one that would not start in
    that folder as far as the mounts tell, which writes nothing: it
    starts where the folder is ``/``, the machine's own, or Mirage's
    mounts are served into the machine. A program no name captures is on
    the machine search order picks from that folder (``searched_machine``).

    A path is looked up only when no file policy speaks for the session:
    the lookup asks the dispatcher before the reader is admitted, and a
    policy judges a call inside the command that makes it.

    Args:
        fed_by (PipeWriter): the pipe's writer.
        session (SessionState): the session its reader runs in.
        registry (MountRegistry): the workspace's mounts and machines.
        routing (RouteDecision): the line's placement.
        namespace (Namespace): the link table the path is read through.
        dispatch (DispatchFn): op dispatcher, which the path is asked of.
    """
    head = program_head(registry, fed_by.words, session, routing)
    paths = _writer_paths(fed_by, registry)
    runtime: RuntimeIdentity | None = None
    if "/" in head and not (
        await registry.policies.wants_for("pre_vfs", session.session_id)
    ):
        runtime = await program_machine(
            PathSpec.from_str_path(head, cwd=fed_by.cwd).virtual,
            session,
            registry,
            namespace.session_links(session),
            dispatch,
            None,
            paths=paths,
            cwd=fed_by.cwd,
        )
    if runtime is None:
        runtime = await searched_machine(
            head, paths, session, registry, routing, fed_by.cwd
        )
    if runtime is None:
        runtime = program_runtime(registry, fed_by.words, session, routing)
    if not isinstance(runtime, RemoteRuntime):
        return None
    name = runtime.default_machine
    if (
        norm(fed_by.cwd) == "/"
        or runtime.handle().config.mount_type is not None
    ):
        return name
    return name if name in folder_machines(fed_by.cwd, registry) else None
