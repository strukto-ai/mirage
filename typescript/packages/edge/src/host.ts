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

import {
  buildCliEntries,
  configToWorkspaceArgs,
  loadProfilePolicy,
  type ConfigHost,
  type StoreBlock,
} from '@struktoai/mirage-core/config'
import type { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import { VFSConfigError } from '@struktoai/mirage-core/vfs/errors'
import { buildVfs, knownVfsNames } from '@struktoai/mirage-core/vfs/registry'
import { savedVfsBuild } from '@struktoai/mirage-core/workspace/snapshot/state'
import type { MountSnapshot } from '@struktoai/mirage-core/workspace/snapshot/types'
import type { WorkspaceStateStore } from '@struktoai/mirage-core/workspace/store/base'
import { RAMWorkspaceStateStore } from '@struktoai/mirage-core/workspace/store/ram'
import { Workspace as CoreWorkspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import type { ServerHost } from '@struktoai/mirage-server/routes'
import './monty.ts'

export class Workspace extends CoreWorkspace {
  /** A saved mount rebuilds through core's VFS registry. */
  protected static override async buildSavedVfs(entry: MountSnapshot): Promise<BaseVFS | null> {
    const build = savedVfsBuild(entry, (name) => knownVfsNames().includes(name))
    return build === null ? null : buildVfs(build.name, build.config)
  }
}

function noop(): void {
  /* an edge host enforces no network rule of its own */
}

/** A workspace's state lives in memory: the host has no disk and no store client. */
function buildStateStore(block: StoreBlock | null | undefined): WorkspaceStateStore | undefined {
  if (block === null || block === undefined) return undefined
  const groups = [block.namespace, block.observer, block.workspace, block.jobs]
  if ((block.type ?? 'ram') !== 'ram' || groups.some((g) => g != null && g.type !== 'ram')) {
    throw new VFSConfigError('an edge host keeps workspace state in memory; store.type must be ram')
  }
  return new RAMWorkspaceStateStore()
}

function refuse(what: string): never {
  throw new Error(`an edge host cannot ${what}`)
}

const CONFIG: ConfigHost = {
  buildVfs,
  buildStateStore,
  readScript: (path) => refuse(`read the script file ${path}; inline its source`),
  loadRef: (ref) => Promise.reject(new Error(`an edge host cannot import ${ref}`)),
  watchNetwork: noop,
  releaseNetwork: () => Promise.resolve(),
}

/**
 * The server's host on an edge runtime: core's VFS registry and config
 * loader, workspace state in memory, no disk, no kernel mounts, no module
 * loading by reference.
 */
export const HOST: ServerHost = {
  Workspace,
  workspaceArgs: (cfg) => configToWorkspaceArgs(cfg, CONFIG),
  buildVfs,
  buildCliEntries: (clis, sources) => buildCliEntries(clis, sources, CONFIG),
  loadProfile: (profile) => loadProfilePolicy(profile, CONFIG),
  stateStore: () => new RAMWorkspaceStateStore(),
  quoteName: (name) =>
    encodeURIComponent(name).replace(
      /[!'()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    ),
  reservedIds: new Set(['', '.', '..']),
  watchNetwork: noop,
  mountKernel: () => Promise.reject(new Error('an edge host has no kernel mounts')),
}
