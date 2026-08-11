// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import type { ObserverStore } from '../../observe/store.ts'
import { RAMWorkspaceStateStore } from '../store/ram.ts'
import type { WorkspaceStateStore } from '../store/base.ts'
import type { NamespaceStore } from '../mount/namespace/store.ts'
import type { SessionStore } from '../session/store.ts'
import type { WorkspaceOptions } from './types.ts'

/**
 * The workspace's control-plane stores, resolved from one provider.
 * Mirrors the Python `ControlStores` in `workspace/build.py`.
 */
export interface ControlStores {
  stateStore: WorkspaceStateStore
  owned: boolean
  observe: ObserverStore
  namespace: NamespaceStore
  sessions: SessionStore
}

/**
 * Resolve the state-store provider and its three planes.
 *
 * One provider scopes every control-plane store by workspace id; the
 * per-plane options (observe / namespaceStore / sessionStore) remain as
 * direct overrides that win over the provider. A caller-passed provider
 * may be shared with sibling workspaces, so only a workspace that built
 * its own provider — or was told it owns the passed one — closes it.
 */
export function resolveControlStores(wsId: string, options: WorkspaceOptions): ControlStores {
  const owned = options.store === undefined || options.ownsStore === true
  const stateStore = options.store ?? new RAMWorkspaceStateStore()
  return {
    stateStore,
    owned,
    observe: options.observe ?? stateStore.observer(wsId),
    namespace: options.namespaceStore ?? stateStore.namespace(wsId),
    sessions: options.sessionStore ?? stateStore.sessions(wsId),
  }
}
