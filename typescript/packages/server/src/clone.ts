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

import { resourceStateRequiresOverride } from '@struktoai/mirage-core/resource/secrets'
import { toStateDict } from '@struktoai/mirage-core/workspace/snapshot/state'
import type { WorkspaceStateDict } from '@struktoai/mirage-core/workspace/snapshot/types'
import { normMountPrefix } from '@struktoai/mirage-core/workspace/snapshot/utils'
import type { Workspace as CoreWorkspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import type { Resource } from '@struktoai/mirage-core/resource/base'
import type { SourceEntries } from '@struktoai/mirage-core/secrets/config'
import { Workspace, buildResource } from '@struktoai/mirage-node'

interface OverrideMountBlock {
  resource: string
  config?: Record<string, unknown>
}

export interface OverrideShape {
  mounts?: Record<string, OverrideMountBlock>
  /** `secrets:` declarations for the restored env pointers. */
  secrets?: SourceEntries
}

export async function buildOverrideResources(
  override: OverrideShape | null,
): Promise<Record<string, Resource>> {
  const mounts = override?.mounts
  if (mounts === undefined) return {}
  const out: Record<string, Resource> = {}
  for (const [prefix, block] of Object.entries(mounts)) {
    out[normMountPrefix(prefix)] = await buildResource(block.resource, block.config ?? {})
  }
  return out
}

function existingRedactedResources(
  src: CoreWorkspace,
  state: WorkspaceStateDict,
  skip: Set<string>,
): Record<string, Resource> {
  const prefixToResource: Record<string, Resource> = {}
  for (const m of src.mounts()) {
    prefixToResource[normMountPrefix(m.prefix)] = m.resource
  }
  const out: Record<string, Resource> = {}
  for (const m of state.mounts) {
    const prefix = normMountPrefix(m.prefix)
    if (skip.has(prefix)) continue
    const resource = prefixToResource[prefix]
    if (resource !== undefined && resourceStateRequiresOverride(m.resource_state)) {
      out[prefix] = resource
    }
  }
  return out
}

export async function cloneWorkspaceWithOverride(
  src: CoreWorkspace,
  override: OverrideShape | null,
): Promise<Workspace> {
  const overrideResources = await buildOverrideResources(override)
  const state = await toStateDict(src)
  const existing = existingRedactedResources(src, state, new Set(Object.keys(overrideResources)))
  const merged = { ...existing, ...overrideResources }
  // Same-process, so the declarations travel with the clone the way a
  // reused remote resource does: the state carries the env pointers
  // but never the `secrets:` block behind them. An override naming its
  // own wins, the way a mount override does, so a staging clone does
  // not keep reading production accounts.
  const secrets = override?.secrets ?? src.declaredSources
  return Workspace.fromState(state, { secrets }, merged)
}
