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

import type { FileCache } from '../../cache/file/mixin.ts'
import { GENERAL_COMMANDS } from '../../commands/builtin/general/index.ts'
import type { Resource } from '../../resource/base.ts'
import { DevResource } from '../../resource/dev/dev.ts'
import { ConsistencyPolicy, MountMode, PathSpec } from '../../types.ts'
import { Mount } from './mount.ts'

export const DEV_PREFIX = '/dev/'

function isFileCache(resource: Resource): resource is Resource & FileCache {
  const r = resource as Partial<FileCache>
  return (
    typeof r.allCached === 'function' && typeof r.get === 'function' && typeof r.set === 'function'
  )
}

export interface OpsMountInfo {
  prefix: string
  resourceType: string
  mode: MountMode
}

export class MountRegistry {
  private readonly mountList: Mount[]
  private defaultMountRef: Mount | null = null
  private consistency: ConsistencyPolicy = ConsistencyPolicy.LAZY
  private readonly defaultMode: MountMode

  constructor(
    resources: Record<string, Resource>,
    defaultMode: MountMode,
    modeOverrides: Record<string, MountMode> = {},
  ) {
    this.defaultMode = defaultMode
    const mounts: Mount[] = []
    const seen = new Set<string>()
    const overrides: Record<string, MountMode> = {}
    for (const [k, v] of Object.entries(modeOverrides)) {
      overrides[normalizePrefix(k)] = v
    }
    mounts.push(
      new Mount({ prefix: DEV_PREFIX, resource: new DevResource(), mode: MountMode.WRITE }),
    )
    seen.add(DEV_PREFIX)
    for (const [rawPrefix, resource] of Object.entries(resources)) {
      const prefix = normalizePrefix(rawPrefix)
      if (seen.has(prefix)) {
        throw new Error(`duplicate mount prefix: ${prefix}`)
      }
      seen.add(prefix)
      const mode = overrides[prefix] ?? defaultMode
      mounts.push(new Mount({ prefix, resource, mode }))
    }
    mounts.sort((a, b) => b.prefix.length - a.prefix.length)
    this.mountList = mounts
  }

  setConsistency(consistency: ConsistencyPolicy): void {
    this.consistency = consistency
  }

  getConsistency(): ConsistencyPolicy {
    return this.consistency
  }

  /**
   * Add a mount dynamically. Mirrors Python's `registry.mount(...)`.
   * Registers the resource's commands and ops on the new mount and
   * re-sorts mounts by prefix length (longest first).
   */
  mount(
    prefix: string,
    resource: Resource,
    mode: MountMode = MountMode.READ,
    consistency: ConsistencyPolicy = ConsistencyPolicy.LAZY,
  ): Mount {
    const norm = normalizePrefix(prefix)
    for (const existing of this.mountList) {
      if (existing.prefix === norm) {
        throw new Error(`duplicate mount prefix: ${norm}`)
      }
    }
    const m = new Mount({ prefix: norm, resource, mode, consistency })
    const cmds = resource.commands?.()
    if (cmds !== undefined) {
      for (const cmd of cmds) {
        if (cmd.filetype !== null) m.register(cmd)
        else if (cmd.resource === null) m.registerGeneral(cmd)
        else m.register(cmd)
      }
    }
    for (const cmd of GENERAL_COMMANDS) {
      m.registerGeneral(cmd)
    }
    const ops = resource.ops?.()
    if (ops !== undefined) {
      for (const op of ops) {
        if (op.resource === null) m.registerGeneralOp(op)
        else m.registerOp(op)
      }
    }
    this.mountList.push(m)
    this.mountList.sort((a, b) => b.prefix.length - a.prefix.length)
    return m
  }

  /**
   * Remove a mount by exact prefix. Mirrors Python's `registry.unmount(...)`.
   * Per-mount commands and ops live on the Mount instance and die with it.
   * The /dev/ mount is reserved and cannot be removed.
   */
  unmount(prefix: string): Mount {
    const norm = normalizePrefix(prefix)
    if (norm === DEV_PREFIX) {
      throw new Error(`cannot unmount reserved prefix: ${norm}`)
    }
    const idx = this.mountList.findIndex((m) => m.prefix === norm)
    if (idx === -1) {
      throw new Error(`no mount at prefix: ${norm}`)
    }
    const [removed] = this.mountList.splice(idx, 1)
    if (removed === undefined) {
      throw new Error(`no mount at prefix: ${norm}`)
    }
    return removed
  }

  mountForPrefix(prefix: string): Mount | null {
    const norm = normalizePrefix(prefix)
    for (const m of this.mountList) {
      if (m.prefix === norm) return m
    }
    return null
  }

  isMountRoot(path: string): boolean {
    return this.mountForPrefix(path) !== null
  }

  descendantMounts(path: string): Mount[] {
    const norm = normalizePrefix(path)
    const out: Mount[] = []
    for (const m of this.mountList) {
      if (m.prefix === norm) continue
      if (!m.prefix.startsWith(norm)) continue
      out.push(m)
    }
    return out.sort((a, b) => (a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0))
  }

  childMountNames(parentPath: string, includeHidden = false): string[] {
    const norm = normalizePrefix(parentPath)
    const seen = new Set<string>()
    const out: string[] = []
    for (const m of this.mountList) {
      if (m.prefix === norm) continue
      if (!m.prefix.startsWith(norm)) continue
      const rest = m.prefix.slice(norm.length)
      const slash = rest.indexOf('/')
      const name = slash === -1 ? rest : rest.slice(0, slash)
      if (name === '') continue
      if (!includeHidden && name.startsWith('.')) continue
      if (seen.has(name)) continue
      seen.add(name)
      out.push(name)
    }
    return out.sort()
  }

  opsMounts(): OpsMountInfo[] {
    return this.mountList.map((m) => ({
      prefix: m.prefix,
      resourceType: m.resource.kind,
      mode: m.mode,
    }))
  }

  findResourceByName(resourceName: string | null): Resource | null {
    if (resourceName === null) return null
    for (const m of this.mountList) {
      if (m.resource.kind === resourceName) return m.resource
    }
    return null
  }

  getResourceType(path: string | null): string | null {
    if (path === null) return null
    try {
      const [resource] = this.resolve(path)
      return resource.kind
    } catch {
      return null
    }
  }

  groupByMount(paths: readonly string[]): [Mount, string[]][] {
    const groups = new Map<Mount, string[]>()
    for (const path of paths) {
      const m = this.mountFor(path)
      if (m === null) continue
      const [, spec] = this.resolve(path)
      let bucket = groups.get(m)
      if (bucket === undefined) {
        bucket = []
        groups.set(m, bucket)
      }
      bucket.push(spec.original)
    }
    return [...groups.entries()]
  }

  setDefaultMount(resource: Resource): Mount {
    const mount = new Mount({ prefix: '/_default/', resource, mode: MountMode.WRITE })
    const ops = resource.ops?.()
    if (ops !== undefined) {
      for (const op of ops) {
        if (op.resource === null) mount.registerGeneralOp(op)
        else mount.registerOp(op)
      }
    }
    this.defaultMountRef = mount
    return mount
  }

  get defaultMount(): Mount | null {
    return this.defaultMountRef
  }

  resolve(path: string): [Resource, PathSpec, MountMode] {
    const m = this.mountFor(path)
    if (m === null) {
      throw new Error(`no mount matches path: ${path}`)
    }
    const hadTrailing = path.endsWith('/')
    const norm = `/${path.replace(/^\/+|\/+$/g, '')}`
    const mountPrefix = m.prefix.replace(/\/+$/, '')
    return [m.resource, PathSpec.fromStrPath(hadTrailing ? `${norm}/` : norm, mountPrefix), m.mode]
  }

  mountFor(path: string): Mount | null {
    const norm = `/${path.replace(/^\/+|\/+$/g, '')}`
    for (const m of this.mountList) {
      const prefixNoTrail = m.prefix.replace(/\/+$/, '') || '/'
      if (norm === prefixNoTrail || norm.startsWith(m.prefix)) {
        return m
      }
    }
    return null
  }

  allMounts(): readonly Mount[] {
    return this.mountList
  }

  isExecAllowed(): boolean {
    for (const m of this.mountList) {
      const prefixNoTrail = m.prefix.replace(/\/+$/, '') || '/'
      if (prefixNoTrail === '/') return m.mode === MountMode.EXEC
    }
    if (this.defaultMode === MountMode.EXEC) return true
    for (const m of this.mountList) {
      if (m.prefix === DEV_PREFIX) continue
      if (m.mode === MountMode.EXEC) return true
    }
    return false
  }

  mountForCommand(cmdName: string): Mount | null {
    if (this.defaultMountRef !== null) {
      const cmd = this.defaultMountRef.resolveCommand(cmdName)
      if (cmd !== null) return this.defaultMountRef
    }
    for (const m of this.mountList) {
      if (m.prefix === DEV_PREFIX) continue
      const cmd = m.resolveCommand(cmdName)
      if (cmd === null) continue
      return m
    }
    return null
  }

  async resolveMount(
    cmdName: string,
    pathScopes: readonly PathSpec[],
    cwd: string,
  ): Promise<Mount | null> {
    const mountPath = pathScopes.length > 0 ? (pathScopes[0]?.original ?? cwd) : cwd
    let mount = this.mountFor(mountPath)
    if (mount?.resolveCommand(cmdName) == null) {
      mount = this.mountForCommand(cmdName)
    }
    if (mount === null) return null
    const defaultMount = this.defaultMountRef
    if (defaultMount !== null && pathScopes.length > 0 && isFileCache(defaultMount.resource)) {
      const baseCmd = mount.resolveCommand(cmdName)
      if (!baseCmd?.write) {
        if (this.consistency === ConsistencyPolicy.ALWAYS) {
          await this.evictStale(mount, defaultMount.resource, pathScopes)
        }
        const keys = pathScopes.map((p) => p.original)
        if (await defaultMount.resource.allCached(keys)) {
          mount = defaultMount
        }
      }
    }
    return mount
  }

  private async evictStale(
    realMount: Mount,
    cache: FileCache,
    pathScopes: readonly PathSpec[],
  ): Promise<void> {
    const resource = realMount.resource
    if (resource.fingerprint === undefined) return
    const mountPrefix = realMount.prefix.replace(/\/+$/, '')
    for (const scope of pathScopes) {
      const key = scope.original
      if (!(await cache.exists(key))) continue
      const prefixedScope = new PathSpec({
        original: scope.original,
        directory: scope.directory,
        pattern: scope.pattern,
        resolved: scope.resolved,
        prefix: mountPrefix,
      })
      let remoteFp: string | null = null
      try {
        remoteFp = await resource.fingerprint(prefixedScope)
      } catch {
        continue
      }
      if (remoteFp === null) continue
      if (!(await cache.isFresh(key, remoteFp))) {
        await cache.remove(key)
      }
    }
  }
}

function normalizePrefix(prefix: string): string {
  const stripped = prefix.replace(/^\/+|\/+$/g, '')
  return stripped ? `/${stripped}/` : '/'
}
