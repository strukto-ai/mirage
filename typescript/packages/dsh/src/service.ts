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

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { MountSpec, Runtime, RuntimeEntry } from '@struktoai/mirage-core'
import { buildRuntime, parseMountMode } from '@struktoai/mirage-core'
import { buildResource, Workspace } from '@struktoai/mirage-node'
import type { Mount, NodeWorkspaceOptions } from '@struktoai/mirage-node'

declare module '@deepseek-ai/cordis' {
  interface Context {
    mirage: MirageService
  }
}

/**
 * A declarative mount, YAML-friendly: the resource is named by its
 * registry type and built through `buildResource`, so a dsh bundle
 * patch can mount anything without holding a live instance. Told apart
 * from a live `Mount` by the type of `resource`: a string names a
 * registry entry, an object is the instance itself.
 */
export interface MirageMountBlock {
  /** Resource registry name (`ram`, `s3`, `slack`, `redis`, ...). */
  resource: string
  /** Mount mode: `read`, `write`, or `exec`. Omitted = the workspace default. */
  mode?: string
  /** Resource constructor config, passed to the registry factory. */
  config?: Record<string, unknown>
}

/** One mount entry: a live spec or instance, or a declarative block. */
export type MirageMount = MountSpec | Mount | MirageMountBlock

/** A runtime entry, YAML-friendly: a name, or a name with captures. */
export interface MirageRuntimeBlock {
  /** Runtime registry name (`monty`, `pyodide`, `quickjs`, ...). */
  name: string
  /** Command words this runtime captures (e.g. `['python', 'python3']`). */
  captures?: string[]
}

/**
 * Configuration for the shared mirage execution world. Exactly one of
 * `workspace` (adopt a live workspace the embedder owns and closes) or
 * `mounts` (construct a workspace here; the service closes it when its
 * plugin unloads) must be given.
 */
export interface MirageConfig {
  /** A live workspace to adopt; its lifecycle stays with the embedder. */
  workspace?: Workspace
  /** Mounts for a service-owned workspace, keyed by mount prefix. */
  mounts?: Record<string, MirageMount>
  /**
   * Runtimes for a service-owned workspace, built via `buildRuntime`.
   * The YAML-friendly twin of `workspaceOptions.runtimes`; pass one or
   * the other, not both.
   */
  runtimes?: (string | MirageRuntimeBlock)[]
  /** Options forwarded to the service-owned workspace's constructor. */
  workspaceOptions?: NodeWorkspaceOptions
}

function isMountBlock(entry: MirageMount): entry is MirageMountBlock {
  if (Array.isArray(entry)) return false
  return typeof (entry as MirageMountBlock).resource === 'string'
}

async function resolveMount(entry: MirageMountBlock): Promise<MountSpec> {
  const resource = await buildResource(entry.resource, entry.config ?? {})
  if (entry.mode === undefined) return resource
  return [resource, parseMountMode(entry.mode)]
}

function toRuntimeEntry(entry: string | MirageRuntimeBlock): RuntimeEntry {
  if (typeof entry === 'string') return entry
  return buildRuntime(entry.name, entry.captures === undefined ? {} : { captures: entry.captures })
}

// A name shorthand builds exactly as the workspace would build it; holding
// the instance early is what lets `vfsOnly` classify the world before the
// (asynchronous) mounts finish resolving.
function builtEntry(entry: RuntimeEntry): Runtime {
  return typeof entry === 'string' ? buildRuntime(entry) : entry
}

/**
 * The one mirage `Workspace` behind every mirage-backed dsh provider
 * (`ctx.mirage`, mirroring how `ctx.e2b` owns one sandbox for the E2B
 * adapters). `MirageFileSystem` and `MirageShellExecutor` both inject it,
 * which is what keeps `ctx.fs` targets and `ctx.shell` commands in one
 * execution world: a `processPath` handed to the shell resolves there.
 *
 * Construction with live resources is synchronous; a declarative mount
 * block defers to `buildResource`, so consumers await `ready` (the
 * adapters do) and `workspace` throws until it resolves, mirroring how
 * the E2B service owner exposes its sandbox.
 */
export class MirageService extends Service {
  static readonly provide = 'mirage'

  /** Resolves to the shared workspace once every mount is built. */
  readonly ready: Promise<Workspace>

  private built: Workspace | null = null
  private readonly plannedRuntimes: readonly Runtime[] | undefined

  constructor(ctx: Context, config: MirageConfig = {}) {
    super(ctx, 'mirage')
    if (config.workspace !== undefined && config.mounts !== undefined) {
      throw new Error('mirage: pass either workspace or mounts, not both')
    }
    if (config.workspace !== undefined) {
      this.built = config.workspace
      this.ready = Promise.resolve(config.workspace)
      return
    }
    if (config.mounts === undefined) {
      throw new Error('mirage: one of workspace or mounts is required')
    }
    const options = { ...(config.workspaceOptions ?? {}) }
    if (config.runtimes !== undefined) {
      if (options.runtimes !== undefined) {
        throw new Error('mirage: pass runtimes or workspaceOptions.runtimes, not both')
      }
      options.runtimes = config.runtimes.map(toRuntimeEntry)
    }
    this.plannedRuntimes = options.runtimes?.map(builtEntry)
    if (this.plannedRuntimes !== undefined) options.runtimes = [...this.plannedRuntimes]
    const blocks = Object.values(config.mounts).some(isMountBlock)
    if (blocks) {
      this.ready = this.open(config.mounts, options)
    } else {
      const owned = new Workspace(config.mounts as Record<string, MountSpec | Mount>, options)
      this.built = owned
      this.ready = Promise.resolve(owned)
    }
    ctx.effect(
      () => async () => {
        const ws = await this.ready.catch(() => null)
        if (ws !== null) await ws.close()
      },
      'mirage workspace',
    )
  }

  /** The live workspace; throws until `ready` resolves. */
  get workspace(): Workspace {
    if (this.built === null) {
      throw new Error('mirage: workspace is not ready yet; await ctx.mirage.ready')
    }
    return this.built
  }

  /**
   * True while every runtime in the world reaches only the vfs
   * (`Runtime.reach`), meaning the workspace dispatch is the single
   * gate for anything the agent can execute: every effect passes
   * mount modes, session grants, and policy before touching the real
   * backend behind a mount. The default world qualifies, and so do
   * the bridged engines, while the host `local` python or a remote
   * sandbox can act around the gate. Answers before `ready` from the
   * constructor-resolved entries (mounts resolve asynchronously,
   * runtimes never do) and from the live workspace afterwards, so a
   * later `addRuntime` is seen.
   */
  get vfsOnly(): boolean {
    const entries = this.built === null ? (this.plannedRuntimes ?? []) : this.built.runtimeEntries
    return entries.every((entry) => entry.reach === 'vfs')
  }

  private async open(
    mounts: Record<string, MirageMount>,
    options: NodeWorkspaceOptions,
  ): Promise<Workspace> {
    const resolved: Record<string, MountSpec | Mount> = {}
    for (const [prefix, entry] of Object.entries(mounts)) {
      resolved[prefix] = isMountBlock(entry) ? await resolveMount(entry) : entry
    }
    const ws = new Workspace(resolved, options)
    this.built = ws
    return ws
  }
}
