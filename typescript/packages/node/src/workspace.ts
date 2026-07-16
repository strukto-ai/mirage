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
import {
  type CommandSafeguard,
  createShellParser,
  type ExecuteOptions,
  type ExecuteResult,
  type MountSpec,
  type ProvisionResult,
  type ShellParser,
  Workspace as CoreWorkspace,
  type WorkspaceOptions,
} from '@struktoai/mirage-core'
import { FuseManager } from './workspace/fuse.ts'
import { Mount } from './workspace/mount_spec.ts'
import './compression_codecs.ts'

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
  private fuseSetupPromise: Promise<void> | null = null
  private readonly fuseMountpointsMap = new Map<string, string>()
  private readonly fuseManagers = new Map<string, FuseManager>()

  constructor(resources: Record<string, MountSpec | Mount>, options: NodeWorkspaceOptions = {}) {
    const specs: Record<string, MountSpec> = {}
    const commandSafeguards: Record<string, Record<string, CommandSafeguard>> = {
      ...(options.commandSafeguards ?? {}),
    }
    const fuseTargets: [string, boolean | string][] = []
    for (const [prefix, value] of Object.entries(resources)) {
      if (value instanceof Mount) {
        specs[prefix] =
          value.options.mode !== undefined ? [value.resource, value.options.mode] : value.resource
        if (value.options.commandSafeguards !== undefined)
          commandSafeguards[prefix] = value.options.commandSafeguards
        if (value.options.fuse !== undefined && value.options.fuse !== false)
          fuseTargets.push([prefix, value.options.fuse])
      } else {
        specs[prefix] = value
      }
    }
    super(specs, {
      ...options,
      ...(Object.keys(commandSafeguards).length > 0 ? { commandSafeguards } : {}),
      shellParserFactory: options.shellParserFactory ?? loadShellParser,
    })
    if (fuseTargets.length > 0) {
      // Kick off mounts eagerly; await inside fuseReady() / execute() / close()
      // so callers don't need to await the constructor (Python mirrors this).
      //
      // A failed auto-mount (e.g. libfuse absent on the host) degrades to an
      // unmounted but fully usable workspace, mirroring Python: there the mount
      // runs on a daemon thread so its failure never reaches the main process.
      // On Node's single event loop we swallow it here, otherwise the unhandled
      // rejection would terminate the process under Node's default policy.
      const setups = fuseTargets.map(([prefix, target]) =>
        this.addFuseMount(prefix, typeof target === 'string' ? target : undefined).then(
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

  private registerFuseMount(prefix: string, mountpoint: string): void {
    for (const [otherPrefix, otherMp] of this.fuseMountpointsMap) {
      if (otherMp === mountpoint && otherPrefix !== prefix) {
        throw new Error(
          `FUSE mountpoint ${mountpoint} already used by prefix ${otherPrefix}; mounts need distinct paths`,
        )
      }
    }
    this.fuseMountpointsMap.set(prefix, mountpoint)
  }

  /**
   * Mount a workspace subtree under FUSE and own its lifecycle. Each mount gets
   * its own {@link FuseManager}, so a workspace can expose any number of FUSE
   * subtrees at once. A pinned mountpoint is collision-checked BEFORE mounting,
   * so a clash never leaves a partial kernel mount.
   *
   * A session-bound mount (`sessionId` given) runs every op under that
   * session's mount grants (the kernel-tier primitive: bind-mount the tree
   * into a container and the narrowing travels with it); it is keyed
   * separately so the same prefix can also be exposed unbound.
   */
  async addFuseMount(prefix: string, mountpoint?: string, sessionId?: string): Promise<string> {
    const session = sessionId !== undefined ? this.getSession(sessionId) : undefined
    const key = sessionId === undefined ? prefix : `${prefix}@${sessionId}`
    if (mountpoint !== undefined) this.registerFuseMount(key, mountpoint)
    const fm = new FuseManager()
    this.fuseManagers.set(key, fm)
    try {
      const mp = await fm.setup(this, {
        rootPrefix: prefix,
        ...(mountpoint !== undefined ? { mountpoint } : {}),
        ...(session !== undefined ? { session } : {}),
      })
      if (mountpoint === undefined) this.registerFuseMount(key, mp)
      return mp
    } catch (err) {
      // The mount never came up; drop the manager and any registered path so
      // fuseMountpoints does not misreport it as live.
      this.fuseManagers.delete(key)
      this.fuseMountpointsMap.delete(key)
      throw err
    }
  }

  async removeFuseMount(prefix: string, sessionId?: string): Promise<void> {
    const key = sessionId === undefined ? prefix : `${prefix}@${sessionId}`
    const fm = this.fuseManagers.get(key)
    this.fuseManagers.delete(key)
    if (fm !== undefined) await fm.unmount()
    this.fuseMountpointsMap.delete(key)
  }

  get fuseMountpoints(): Record<string, string> {
    return Object.fromEntries(this.fuseMountpointsMap)
  }

  get fuseMountpoint(): string | null {
    if (this.fuseMountpointsMap.size === 0) return null
    if (this.fuseMountpointsMap.size > 1) {
      throw new Error('multiple FUSE mounts active; use fuseMountpoints to select one by prefix')
    }
    return this.fuseMountpointsMap.values().next().value ?? null
  }

  /** Await the eager per-mount fuse mounts started in the constructor. */
  async fuseReady(): Promise<void> {
    if (this.fuseSetupPromise !== null) {
      await this.fuseSetupPromise
      this.fuseSetupPromise = null
    }
  }

  override execute(
    command: string,
    options?: ExecuteOptions & { provision?: false | undefined },
  ): Promise<ExecuteResult>
  override execute(
    command: string,
    options: ExecuteOptions & { provision: true },
  ): Promise<ProvisionResult>
  override execute(
    command: string,
    options: ExecuteOptions,
  ): Promise<ExecuteResult | ProvisionResult>
  override async execute(
    command: string,
    options: ExecuteOptions = {},
  ): Promise<ExecuteResult | ProvisionResult> {
    await this.fuseReady()
    return super.execute(command, options)
  }

  override async close(): Promise<void> {
    await this.fuseReady().catch(() => undefined)
    for (const fm of this.fuseManagers.values()) await fm.unmount()
    this.fuseManagers.clear()
    this.fuseMountpointsMap.clear()
    await super.close()
  }
}
