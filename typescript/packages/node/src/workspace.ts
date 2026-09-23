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

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { ProvisionResult } from '@struktoai/mirage-core/provision/types'
import { createShellParser } from '@struktoai/mirage-core/shell/parse'
import type { ShellParser } from '@struktoai/mirage-core/shell/parse'
import { KERNEL_BACKENDS, MountBackend } from '@struktoai/mirage-core/types'
import { Workspace as CoreWorkspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import type {
  ExecuteOptions,
  ExecuteResult,
  MountSpec,
  WorkspaceOptions,
} from '@struktoai/mirage-core/workspace/workspace/workspace'
import { KernelMounts } from './workspace/workspace/kernel_mounts.ts'
import { Mount } from '@struktoai/mirage-core/workspace/mount/spec'
import { savedVfsBuild } from '@struktoai/mirage-core/workspace/snapshot/state'
import type { MountSnapshot } from '@struktoai/mirage-core/workspace/snapshot/types'
import { buildVfs, knownVfsNames } from './vfs/registry.ts'
import type { VFS } from '@struktoai/mirage-core/vfs/base'
import './compression_codecs.ts'
import './runtime/sandbox/daytona/runtime.ts'
import './secrets/constants.ts'

const requireCjs = createRequire(import.meta.url)

let cachedParser: Promise<ShellParser> | null = null

function loadShellParser(): Promise<ShellParser> {
  if (cachedParser !== null) return cachedParser
  const enginePath = requireCjs.resolve('web-tree-sitter/web-tree-sitter.wasm')
  const grammarPath = requireCjs.resolve('tree-sitter-bash/tree-sitter-bash.wasm')
  cachedParser = createShellParser({
    engineWasm: readFileSync(enginePath),
    grammarWasm: readFileSync(grammarPath),
  })
  return cachedParser
}

export type NodeWorkspaceOptions = WorkspaceOptions

export class Workspace extends CoreWorkspace {
  /** A saved mount rebuilds through this package's VFS registry. */
  protected static override async buildSavedVfs(entry: MountSnapshot): Promise<VFS | null> {
    const build = savedVfsBuild(entry, (name) => knownVfsNames().includes(name))
    return build === null ? null : buildVfs(build.name, build.config)
  }

  private fuseSetupPromise: Promise<void> | null = null
  private readonly kernelMounts = new KernelMounts(this)

  constructor(mounts: Record<string, MountSpec>, options: NodeWorkspaceOptions = {}) {
    // Core takes a `Mount` directly now, so this unwrap is down to the one
    // fact core has no use for: which mounts also want a real mountpoint.
    // It used to re-spell the mount as [vfs, mode] and lift commandLimits
    // by hand, which is how a `Mount`'s read policy would have been lost
    // before reaching the workspace.
    const mountTargets: [string, MountBackend, string | undefined][] = []
    for (const [prefix, value] of Object.entries(mounts)) {
      if (!(value instanceof Mount)) continue
      const backend = value.options.backend ?? MountBackend.WORKSPACE
      if (KERNEL_BACKENDS.includes(backend)) {
        mountTargets.push([prefix, backend, value.options.mountpoint])
      }
    }
    super(mounts, {
      ...options,
      shellParserFactory: options.shellParserFactory ?? loadShellParser,
    })
    if (mountTargets.length > 0) {
      // Kick off mounts eagerly; await inside fuseReady() / execute() / close()
      // so callers don't need to await the constructor (Python mirrors this).
      //
      // A failed auto-mount (e.g. libfuse absent on the host) degrades to an
      // unmounted but fully usable workspace, mirroring Python: there the mount
      // runs on a daemon thread so its failure never reaches the main process.
      // On Node's single event loop we swallow it here, otherwise the unhandled
      // rejection would terminate the process under Node's default policy.
      const setups = mountTargets.map(([prefix, backend, mountpoint]) =>
        this.addFuseMount(prefix, mountpoint, undefined, backend).then(
          () => undefined,
          (err: unknown) => {
            process.stderr.write(
              `mirage: FUSE auto-mount failed for ${prefix}, continuing without it: ${
                err instanceof Error ? err.message : String(err)
              }\n`,
            )
          },
        ),
      )
      this.fuseSetupPromise = Promise.all(setups).then(() => undefined)
    }
  }

  /**
   * Mount a workspace subtree under FUSE and own its lifecycle. Each mount gets
   * its own FuseManager, so a workspace can expose any number of FUSE subtrees
   * at once. A pinned mountpoint is collision-checked BEFORE mounting, so a
   * clash never leaves a partial kernel mount.
   *
   * A session-bound mount (`sessionId` given) runs every op under that
   * session's mount grants (the kernel-tier primitive: bind-mount the tree
   * into a container and the narrowing travels with it); it is keyed
   * separately so the same prefix can also be exposed unbound.
   */
  addFuseMount(
    prefix: string,
    mountpoint?: string,
    sessionId?: string,
    backend?: MountBackend,
  ): Promise<string> {
    return this.kernelMounts.add(prefix, mountpoint, sessionId, backend)
  }

  removeFuseMount(prefix: string, sessionId?: string): Promise<void> {
    return this.kernelMounts.remove(prefix, sessionId)
  }

  get fuseMountpoints(): Record<string, string> {
    return this.kernelMounts.mountpoints
  }

  get fuseMountpoint(): string | null {
    return this.kernelMounts.mountpoint
  }

  /** Await the eager per-mount fuse mounts started in the constructor. */
  async fuseReady(): Promise<void> {
    if (this.fuseSetupPromise !== null) {
      await this.fuseSetupPromise
      this.fuseSetupPromise = null
    }
  }

  override shell(
    command: string,
    options?: ExecuteOptions & { provision?: false | undefined },
  ): Promise<ExecuteResult>
  override shell(
    command: string,
    options: ExecuteOptions & { provision: true },
  ): Promise<ProvisionResult>
  override shell(command: string, options: ExecuteOptions): Promise<ExecuteResult | ProvisionResult>
  override async shell(
    command: string,
    options: ExecuteOptions = {},
  ): Promise<ExecuteResult | ProvisionResult> {
    await this.fuseReady()
    return super.shell(command, options)
  }

  override async close(): Promise<void> {
    await this.fuseReady().catch(() => undefined)
    await this.kernelMounts.close()
    await super.close()
  }
}
