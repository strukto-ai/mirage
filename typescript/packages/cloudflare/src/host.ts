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
  configToWorkspaceArgs,
  loadProfilePolicy,
  type ConfigHost,
  type StoreBlock,
} from '@struktoai/mirage-core/config'
import { watch } from '@struktoai/mirage-core/io/web/gateway'
import { refuseUnseenAddresses, watchNetwork } from '@struktoai/mirage-core/io/web/network'
import { withinRequest } from '@struktoai/mirage-core/io/web/request'
import type { Runtime, RuntimeEntry } from '@struktoai/mirage-core/runtime/base'
import type { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import { VFSConfigError } from '@struktoai/mirage-core/vfs/errors'
import { CONFIG_SCHEMAS } from '@struktoai/mirage-core/vfs/registry'
import type { ShellExecution } from '@struktoai/mirage-core/workspace/shell_execution'
import { savedVfsBuild } from '@struktoai/mirage-core/workspace/snapshot/state'
import {
  generationOf,
  type RecordClient,
  type RecordFields,
} from '@struktoai/mirage-core/workspace/record/types'
import type { MountSnapshot } from '@struktoai/mirage-core/workspace/snapshot/types'
import type { WorkspaceStateStore } from '@struktoai/mirage-core/workspace/store/base'
import type {
  ExecuteOptions,
  ExecuteResult,
  WorkspaceOptions,
} from '@struktoai/mirage-core/workspace/workspace/types'
import { RAMWorkspaceStateStore } from '@struktoai/mirage-core/workspace/store/ram'
import { Workspace as CoreWorkspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import '@struktoai/mirage-core/mount/sftp'
import type { ServerHost } from '@struktoai/mirage-server/routes'
import './monty.ts'
import { EDGE_RUNTIMES } from './constants.ts'
import { buildVfs, knownVfsNames } from './vfs/registry.ts'

/**
 * Refuse QuickJS, which would run on the isolate's only thread: a script that
 * never calls the host runs there until Cloudflare's CPU limit ends the
 * request, holding every workspace in the isolate.
 */
function refuseQuickJs(entry: RuntimeEntry): void {
  if ((typeof entry === 'string' ? entry : entry.name) === 'quickjs') {
    throw new Error(
      "runtime 'quickjs' does not run on Cloudflare Workers: a script that never calls the " +
        'host would hold the isolate',
    )
  }
}

export class Workspace extends CoreWorkspace {
  /** A saved mount rebuilds through the edge's VFS registry. */
  protected static override async buildSavedVfs(entry: MountSnapshot): Promise<BaseVFS | null> {
    const build = savedVfsBuild(entry, (name) => knownVfsNames().includes(name))
    return build === null ? null : buildVfs(build.name, build.config)
  }

  constructor(
    mounts: ConstructorParameters<typeof CoreWorkspace>[0],
    options: WorkspaceOptions = {},
  ) {
    refuseUnseenAddresses(options.network)
    const runtimes = options.runtimes ?? [...EDGE_RUNTIMES]
    runtimes.forEach(refuseQuickJs)
    super(mounts, { ...options, runtimes })
    this.registry.setNetworkWatch(watchNetwork)
    if (this.registry.network !== null) watchNetwork()
    watch()
  }

  override addRuntime(runtime: RuntimeEntry): Runtime {
    refuseQuickJs(runtime)
    return super.addRuntime(runtime)
  }

  /**
   * A line runs inside the request that asks for it, or as one of its own
   * when a worker calls the workspace itself, so a socket a backend opened
   * for an earlier request is not reused.
   */
  override shell(
    command: string,
    options: ExecuteOptions & { stream: true },
  ): Promise<ShellExecution>
  override shell(
    command: string,
    options?: ExecuteOptions & { stream?: false },
  ): Promise<ExecuteResult>
  override shell(command: string, options: ExecuteOptions): Promise<ExecuteResult | ShellExecution>
  override shell(
    command: string,
    options: ExecuteOptions = {},
  ): Promise<ExecuteResult | ShellExecution> {
    return withinRequest(() => super.shell(command, options))
  }

  /** A file op runs inside its request, as a line does. */
  override dispatch(
    ...args: Parameters<CoreWorkspace['dispatch']>
  ): ReturnType<CoreWorkspace['dispatch']> {
    return withinRequest(() => super.dispatch(...args))
  }
}

/** A workspace's state lives in memory: the host has no disk and no store client. */
function buildStateStore(block: StoreBlock | null | undefined): WorkspaceStateStore | undefined {
  if (block === null || block === undefined) return undefined
  const groups = [block.namespace, block.observer, block.workspace, block.execution]
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
  watchNetwork,
  releaseNetwork: () => Promise.resolve(),
}

/**
 * The server's host on an edge runtime: the edge's VFS registry, core's config
 * loader, no disk, no kernel mounts, no module loading by reference. Its
 * workspaces keep their state in one store held in memory, so a closed
 * workspace reopens with it while the isolate lives.
 */
export function edgeHost(): ServerHost {
  const state = new RAMWorkspaceStateStore()
  const daemon = crypto.randomUUID().replaceAll('-', '')
  return {
    Workspace,
    workspaceArgs: (cfg) => configToWorkspaceArgs(cfg, CONFIG),
    buildVfs,
    vfsSchemas: CONFIG_SCHEMAS,
    loadProfile: (profile) => loadProfilePolicy(profile, CONFIG),
    stateStore: () => state,
    daemonId: () => Promise.resolve(daemon),
    quoteName: (name) =>
      encodeURIComponent(name).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    reservedIds: new Set(['', '.', '..']),
    watchNetwork,
    mountKernel: () => Promise.reject(new Error('an edge host has no kernel mounts')),
  }
}

/**
 * Keyed records held in memory: who owns each workspace id, kept across
 * a close as the Node server keeps them on disk, for the isolate's life.
 */
export class RAMRecordClient implements RecordClient {
  private readonly records = new Map<string, RecordFields>()

  get(name: string): Promise<[RecordFields | null, string]> {
    const fields = this.records.get(name)
    return Promise.resolve([fields === undefined ? null : structuredClone(fields), ''])
  }

  put(name: string, fields: RecordFields): Promise<void> {
    this.records.set(name, structuredClone(fields))
    return Promise.resolve()
  }

  casPut(name: string, fields: RecordFields, expectedGeneration: number): Promise<boolean> {
    if (generationOf(this.records.get(name)) !== expectedGeneration) return Promise.resolve(false)
    this.records.set(name, structuredClone(fields))
    return Promise.resolve(true)
  }

  listNames(): Promise<string[]> {
    return Promise.resolve([...this.records.keys()])
  }

  delete(names: readonly string[]): Promise<void> {
    for (const name of names) this.records.delete(name)
    return Promise.resolve()
  }

  clear(): Promise<void> {
    this.records.clear()
    return Promise.resolve()
  }

  close(): Promise<void> {
    return Promise.resolve()
  }
}
