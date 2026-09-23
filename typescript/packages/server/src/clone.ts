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

import { vfsStateRequiresOverride } from '@struktoai/mirage-core/vfs/secrets'
import { toStateDict } from '@struktoai/mirage-core/workspace/snapshot/state'
import type { WorkspaceStateDict } from '@struktoai/mirage-core/workspace/snapshot/types'
import { normMountPrefix } from '@struktoai/mirage-core/workspace/snapshot/utils'
import type { Workspace as CoreWorkspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import type { VFS } from '@struktoai/mirage-core/vfs/base'
import type { SecretEntries } from '@struktoai/mirage-core/secrets/config'
import { resolveSourcesFor } from '@struktoai/mirage-core/secrets/sources'
import { Workspace, buildVfs } from '@struktoai/mirage-node'

interface OverrideMountBlock {
  vfs: string
  config?: Record<string, unknown>
}

export interface OverrideShape {
  mounts?: Record<string, OverrideMountBlock>
  /** `secrets:` declarations for the restored env pointers. */
  secrets?: SecretEntries
}

/**
 * Build the mounts an override supplies, against the declarations the
 * new workspace will run with.
 *
 * Shared by the clone and load doors, which both take the same
 * `mounts: {<prefix>: {VFS, config}}` shape. An override mount
 * reads a pointer the way a yaml one does, so it is built against those
 * declarations, which are built only when an override config names one:
 * an override that swaps a RAM mount never reads a bootstrap file.
 */
export async function buildOverrideMounts(
  override: OverrideShape | null,
  declared: unknown,
): Promise<Record<string, VFS>> {
  const mounts = override?.mounts
  if (mounts === undefined) return {}
  const blocks = Object.entries(mounts)
  const sources = await resolveSourcesFor(
    declared,
    blocks.map(([, block]) => block.config ?? {}),
  )
  const out: Record<string, VFS> = {}
  for (const [prefix, block] of blocks) {
    out[normMountPrefix(prefix)] = await buildVfs(block.vfs, block.config ?? {}, sources)
  }
  return out
}

function existingRedactedMounts(
  src: CoreWorkspace,
  state: WorkspaceStateDict,
  skip: Set<string>,
): Record<string, VFS> {
  const prefixToVfs: Record<string, VFS> = {}
  for (const m of src.mounts()) {
    prefixToVfs[normMountPrefix(m.prefix)] = m.vfs
  }
  const out: Record<string, VFS> = {}
  for (const m of state.mounts) {
    const prefix = normMountPrefix(m.prefix)
    if (skip.has(prefix)) continue
    const vfs = prefixToVfs[prefix]
    if (vfs !== undefined && vfsStateRequiresOverride(m.vfs_state)) {
      out[prefix] = vfs
    }
  }
  return out
}

export async function cloneWorkspaceWithOverride(
  src: CoreWorkspace,
  override: OverrideShape | null,
): Promise<Workspace> {
  const state = await toStateDict(src)
  // Same-process, so the declarations travel with the clone the way a
  // reused remote VFS does: the state carries the env pointers
  // but never the `secrets:` block behind them. An override naming its
  // own wins, the way a mount override does, so a staging clone does
  // not keep reading production accounts.
  const secrets = override?.secrets ?? src.declaredSources
  const overrideMounts = await buildOverrideMounts(override, secrets)
  const existing = existingRedactedMounts(src, state, new Set(Object.keys(overrideMounts)))
  const merged = { ...existing, ...overrideMounts }
  return Workspace.fromState(state, { secrets }, merged)
}
