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

from dataclasses import dataclass

from mirage.observe.store import ObserverStore
from mirage.shell.job_table.store import JobStore
from mirage.workspace.mount.namespace.store import NamespaceStore
from mirage.workspace.store import RAMWorkspaceStateStore, WorkspaceStateStore


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
    sessions: NamespaceStore
    jobs: JobStore


def resolve_control_stores(
    workspace_id: str,
    store: WorkspaceStateStore | None,
    owns_store: bool,
    observe: ObserverStore | None,
    namespace_store: NamespaceStore | None,
    session_store: NamespaceStore | None,
) -> ControlStores:
    """Resolve the state-store provider and its planes.

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
        session_store (NamespaceStore | None): session-table override.
    """
    owned = store is None or owns_store
    state_store = store if store is not None else RAMWorkspaceStateStore()
    if observe is None:
        observe = state_store.observer(workspace_id)
    if namespace_store is None:
        namespace_store = state_store.namespace(workspace_id)
    if session_store is None:
        session_store = state_store.sessions(workspace_id)
    return ControlStores(
        state_store=state_store,
        owned=owned,
        observe=observe,
        namespace=namespace_store,
        sessions=session_store,
        jobs=state_store.jobs(workspace_id),
    )
