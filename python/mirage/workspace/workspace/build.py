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

from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from mirage.observe.store import ObserverStore
from mirage.runtime.base import Runtime
from mirage.runtime.table import VfsRuntime, bind_commands
from mirage.runtime.types import RunResult
from mirage.workspace.mount import MountRegistry
from mirage.workspace.mount.namespace.store import NamespaceStore
from mirage.workspace.session import SessionStore
from mirage.workspace.store import RAMWorkspaceStateStore, WorkspaceStateStore
from mirage.workspace.workspace.policy import PolicyRouter
from mirage.workspace.workspace.runtimes import Runtimes

LineExecutor = Callable[[str, bytes | None, dict[str, str], str],
                        Awaitable[RunResult]]


@dataclass(frozen=True, slots=True)
class ControlStores:
    """The workspace's control-plane stores, resolved from one provider.

    The provider scopes every store by workspace id; the per-plane
    parameters remain as direct overrides that win over the provider.
    """

    state_store: WorkspaceStateStore
    owned: bool
    observe: ObserverStore
    namespace: NamespaceStore
    sessions: SessionStore


def resolve_control_stores(
        workspace_id: str, store: WorkspaceStateStore | None, owns_store: bool,
        observe: ObserverStore | None, namespace_store: NamespaceStore | None,
        session_store: SessionStore | None) -> ControlStores:
    """Resolve the state-store provider and its three planes.

    A caller-passed provider may be shared with sibling workspaces, so
    only a workspace that built its own provider (or was told it owns
    the passed one) closes it.

    Args:
        workspace_id (str): id every derived store is scoped by.
        store (WorkspaceStateStore | None): the provider; None builds
            a private RAM one.
        owns_store (bool): whether a passed provider is owned anyway.
        observe (ObserverStore | None): history-plane override.
        namespace_store (NamespaceStore | None): namespace override.
        session_store (SessionStore | None): session-plane override.
    """
    owned = store is None or owns_store
    state_store = store if store is not None else RAMWorkspaceStateStore()
    if observe is None:
        observe = state_store.observer(workspace_id)
    if namespace_store is None:
        namespace_store = state_store.namespace(workspace_id)
    if session_store is None:
        session_store = state_store.sessions(workspace_id)
    return ControlStores(state_store=state_store,
                         owned=owned,
                         observe=observe,
                         namespace=namespace_store,
                         sessions=session_store)


def wire_runtime_world(
        registry: MountRegistry, dispatch: Callable[..., object],
        mount_prefixes: Callable[[], list[str]],
        entries: list[Runtime | str] | None,
        line_executor: LineExecutor) -> tuple[Runtimes, PolicyRouter]:
    """Build the ordered runtime world and its policy router.

    Instances and the vfs marker; the first capturer binds each
    command. An explicit list fails loud per entry; the default world
    builds gracefully (a missing extra leaves the command reporting
    its install hint per invocation, never a silent escalation to
    another runtime). The vfs runtime, when present, gets the
    workspace executor as its ``run_line``.

    Args:
        registry (MountRegistry): mount table the bindings install on.
        dispatch (Callable[..., object]): the workspace's op dispatch.
        mount_prefixes (Callable[[], list[str]]): live prefix listing.
        entries (list[Runtime | str] | None): explicit runtime world;
            None builds the default.
        line_executor (LineExecutor): the workspace executor bound as
            the vfs runtime's run_line.
    """
    runtimes = Runtimes(registry, dispatch, mount_prefixes)
    runtimes.resolve(entries)
    router = PolicyRouter(registry, runtimes, mount_prefixes)
    registry.runtime_bindings = bind_commands(runtimes.entries)
    registry.vfs_runtime = next(
        (entry for entry in runtimes.entries if isinstance(entry, VfsRuntime)),
        None)
    if isinstance(registry.vfs_runtime, VfsRuntime):
        registry.vfs_runtime.bind_line_executor(line_executor)
    return runtimes, router
