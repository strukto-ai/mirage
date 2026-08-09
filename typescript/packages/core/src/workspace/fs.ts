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

import { NOOPAccessor } from '../accessor/base.ts'
import { applyOpLimit } from '../commands/builtin/utils/limit.ts'
import { getExtension } from '../commands/resolve.ts'
import { OpRecord } from '../observe/record.ts'
import { NO_FOLLOW_OPS, type NamespaceLinks } from '../ops/config.ts'
import { mergeReaddir, structureListing, structureStat } from '../ops/structure.ts'
import type { StatOverlay } from '../ops/types.ts'
import type { OpKwargs, OpsRegistry } from '../ops/registry.ts'
import { type Policies, postOpsGate, preOpsGate } from '../policy/policies.ts'
import type { Resource } from '../resource/base.ts'
import type { FileStat, MountMode } from '../types.ts'
import { FileType, PathSpec } from '../types.ts'
import { isMissingPath } from '../utils/errors.ts'

const NOOP_ACCESSOR_INSTANCE = new NOOPAccessor()

export type Resolver = (path: string) => Promise<[Resource, PathSpec, MountMode]>

export type OpSink = (rec: OpRecord) => Promise<void>

export type PrefixOf = (path: string) => string

export class WorkspaceFS {
  private readonly resolver: Resolver
  private readonly ops: OpsRegistry
  private readonly sink: OpSink | null
  // Injected namespace seam (workspace wires it); FUSE reads `links` for
  // its symlink surface, and every op here follows links before resolving
  // so the facade and dispatch can never disagree on the operand.
  readonly links: NamespaceLinks | null
  private readonly statOverlay: StatOverlay | null
  // Policy seam: this facade is an op door like the dispatcher (FUSE and
  // programmatic access read through it), so pre/post op hooks must fire
  // here too, mirroring the Python Ops door. Null means ungated, for
  // direct construction in tests.
  private readonly policies: Policies | null
  private readonly prefixOf: PrefixOf | null
  // Live view of the workspace mount prefixes, for the structure merge:
  // this facade is a second door beside the dispatcher until they
  // collapse (R2), so both must answer readdir and stat with the same
  // namespace structure. Null means no structure to merge (direct
  // construction in tests).
  private readonly prefixes: (() => string[]) | null

  constructor(
    resolver: Resolver,
    ops: OpsRegistry,
    sink: OpSink | null = null,
    links: NamespaceLinks | null = null,
    statOverlay: StatOverlay | null = null,
    policies: Policies | null = null,
    prefixOf: PrefixOf | null = null,
    prefixes: (() => string[]) | null = null,
  ) {
    this.resolver = resolver
    this.ops = ops
    this.sink = sink
    this.links = links
    this.statOverlay = statOverlay
    this.policies = policies
    this.prefixOf = prefixOf
    this.prefixes = prefixes
  }

  /**
   * The namespace's own answer for a path no backend serves, mirroring
   * the dispatcher: a directory that exists only because a mount or a
   * link sits below it still lists and stats. Null for any other op,
   * or when the namespace knows nothing at `path`.
   */
  private structureResult(op: string, path: string): string[] | FileStat | null {
    if (this.prefixes === null) return null
    if (op === 'readdir') return structureListing(this.prefixes(), this.links, path)
    if (op === 'stat') return structureStat(this.prefixes(), this.links, path)
    return null
  }

  private follow(op: string, path: string): string {
    if (this.links === null || NO_FOLLOW_OPS.has(op)) return path
    return this.links.follow(path)
  }

  private async firePreOps(
    op: string,
    path: string,
    pathSpec: PathSpec,
    write: boolean,
  ): Promise<void> {
    if (this.policies === null) return
    const prefix = this.prefixOf !== null ? this.prefixOf(path) : ''
    await preOpsGate(this.policies, op, pathSpec, write, prefix)
  }

  // Bookkeeping precedes this gate: a denied result is still a completed
  // backend op, so recording runs first and the deny only suppresses
  // what the caller sees (mirrors the Python Ops door).
  private async firePostOps(
    op: string,
    path: string,
    pathSpec: PathSpec,
    write: boolean,
    result: unknown,
  ): Promise<unknown> {
    if (this.policies === null) return result
    const prefix = this.prefixOf !== null ? this.prefixOf(path) : ''
    const bound = await postOpsGate(this.policies, op, pathSpec, write, prefix, result)
    if (bound !== null) return applyOpLimit(result, bound)
    return result
  }

  private async record(
    op: string,
    path: string,
    source: string,
    bytes: number,
    startMs: number,
  ): Promise<void> {
    if (this.sink === null) return
    await this.sink(
      new OpRecord({
        op,
        path,
        source,
        bytes,
        timestamp: Date.now(),
        durationMs: Date.now() - startMs,
      }),
    )
  }

  async readFile(path: string, options: { raw?: boolean } = {}): Promise<Uint8Array> {
    const start = Date.now()
    path = this.follow('read', path)
    const [resource, pathSpec] = await this.resolver(path)
    const filetype = options.raw === true ? null : getExtension(path)
    const kwargs: OpKwargs = {}
    if (filetype !== null) kwargs.filetype = filetype
    if (resource.index !== undefined) kwargs.index = resource.index
    await this.firePreOps('read', path, pathSpec, false)
    const result = (await this.ops.call(
      'read',
      resource.kind,
      resource.accessor ?? NOOP_ACCESSOR_INSTANCE,
      pathSpec,
      [],
      kwargs,
    )) as Uint8Array
    await this.record('read', path, resource.kind, result.byteLength, start)
    return (await this.firePostOps('read', path, pathSpec, false, result)) as Uint8Array
  }

  async readFileText(path: string, encoding = 'utf-8'): Promise<string> {
    const bytes = await this.readFile(path)
    return new TextDecoder(encoding, { fatal: false }).decode(bytes)
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    const start = Date.now()
    path = this.follow('write', path)
    const [resource, pathSpec] = await this.resolver(path)
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
    const kwargs = resource.index !== undefined ? { index: resource.index } : {}
    await this.firePreOps('write', path, pathSpec, true)
    await this.ops.call(
      'write',
      resource.kind,
      resource.accessor ?? NOOP_ACCESSOR_INSTANCE,
      pathSpec,
      [bytes],
      kwargs,
    )
    await this.record('write', path, resource.kind, bytes.byteLength, start)
    await this.firePostOps('write', path, pathSpec, true, null)
  }

  async readdir(path: string): Promise<string[]> {
    const start = Date.now()
    path = this.follow('readdir', path)
    let resolved: [Resource, PathSpec, MountMode]
    try {
      resolved = await this.resolver(path)
    } catch (err) {
      // No mount serves the path; mirror the dispatcher and fire the
      // gates anyway (prefixOf answers '' here) so a policy that bounds
      // readdir by path covers the synthetic answer too.
      const fallback = isMissingPath(err) ? this.structureResult('readdir', path) : null
      if (fallback === null) throw err
      const pathSpec = PathSpec.fromStrPath(path)
      await this.firePreOps('readdir', path, pathSpec, false)
      return (
        ((await this.firePostOps('readdir', path, pathSpec, false, fallback)) as string[] | null) ??
        []
      )
    }
    const [resource, pathSpec] = resolved
    const kwargs = resource.index !== undefined ? { index: resource.index } : {}
    await this.firePreOps('readdir', path, pathSpec, false)
    let result: string[] | null
    try {
      result = (await this.ops.call(
        'readdir',
        resource.kind,
        resource.accessor ?? NOOP_ACCESSOR_INSTANCE,
        pathSpec,
        [],
        kwargs,
      )) as string[] | null
    } catch (err) {
      const fallback = isMissingPath(err) ? this.structureResult('readdir', path) : null
      if (fallback === null) throw err
      result = fallback as string[]
    }
    if (this.prefixes !== null) {
      result = mergeReaddir(result ?? [], this.prefixes(), this.links, path)
    }
    await this.record('readdir', path, resource.kind, 0, start)
    return (
      ((await this.firePostOps('readdir', path, pathSpec, false, result)) as string[] | null) ?? []
    )
  }

  async stat(path: string): Promise<FileStat> {
    const start = Date.now()
    path = this.follow('stat', path)
    let resolved: [Resource, PathSpec, MountMode]
    try {
      resolved = await this.resolver(path)
    } catch (err) {
      // Same gate routing as the readdir resolver miss above.
      const fallback = isMissingPath(err) ? this.structureResult('stat', path) : null
      if (fallback === null) throw err
      const pathSpec = PathSpec.fromStrPath(path)
      await this.firePreOps('stat', path, pathSpec, false)
      return (await this.firePostOps('stat', path, pathSpec, false, fallback)) as FileStat
    }
    const [resource, pathSpec] = resolved
    const kwargs = resource.index !== undefined ? { index: resource.index } : {}
    await this.firePreOps('stat', path, pathSpec, false)
    let result: FileStat
    try {
      result = (await this.ops.call(
        'stat',
        resource.kind,
        resource.accessor ?? NOOP_ACCESSOR_INSTANCE,
        pathSpec,
        [],
        kwargs,
      )) as FileStat
    } catch (err) {
      const fallback = isMissingPath(err) ? this.structureResult('stat', path) : null
      if (fallback === null) throw err
      result = fallback as FileStat
    }
    await this.record('stat', path, resource.kind, 0, start)
    result = (await this.firePostOps('stat', path, pathSpec, false, result)) as FileStat
    if (this.statOverlay !== null) return this.statOverlay(path, result)
    return result
  }

  // The three probes below answer "is this path there?", so only a genuine
  // missing path may read back as false. An auth failure, a timeout, or a
  // backend bug is not an answer to that question: swallowing it would let a
  // caller act on a false "missing" (overwrite, recreate, skip). Mirrors
  // Python's `(FileNotFoundError, ValueError)` swallow set.
  async exists(path: string): Promise<boolean> {
    try {
      await this.stat(path)
      return true
    } catch (err) {
      if (isMissingPath(err)) return false
      throw err
    }
  }

  async isDir(path: string): Promise<boolean> {
    try {
      const s = await this.stat(path)
      return s.type === FileType.DIRECTORY
    } catch (err) {
      if (isMissingPath(err)) return false
      throw err
    }
  }

  async isFile(path: string): Promise<boolean> {
    try {
      const s = await this.stat(path)
      return s.type !== FileType.DIRECTORY
    } catch (err) {
      if (isMissingPath(err)) return false
      throw err
    }
  }

  async mkdir(path: string): Promise<void> {
    const start = Date.now()
    path = this.follow('mkdir', path)
    const [resource, pathSpec] = await this.resolver(path)
    await this.firePreOps('mkdir', path, pathSpec, true)
    await this.ops.call(
      'mkdir',
      resource.kind,
      resource.accessor ?? NOOP_ACCESSOR_INSTANCE,
      pathSpec,
    )
    await this.record('mkdir', path, resource.kind, 0, start)
    await this.firePostOps('mkdir', path, pathSpec, true, null)
  }

  async unlink(path: string): Promise<void> {
    const start = Date.now()
    path = this.follow('unlink', path)
    const [resource, pathSpec] = await this.resolver(path)
    await this.firePreOps('unlink', path, pathSpec, true)
    await this.ops.call(
      'unlink',
      resource.kind,
      resource.accessor ?? NOOP_ACCESSOR_INSTANCE,
      pathSpec,
    )
    await this.record('unlink', path, resource.kind, 0, start)
    await this.firePostOps('unlink', path, pathSpec, true, null)
  }

  async rmdir(path: string): Promise<void> {
    const start = Date.now()
    path = this.follow('rmdir', path)
    const [resource, pathSpec] = await this.resolver(path)
    await this.firePreOps('rmdir', path, pathSpec, true)
    await this.ops.call(
      'rmdir',
      resource.kind,
      resource.accessor ?? NOOP_ACCESSOR_INSTANCE,
      pathSpec,
    )
    await this.record('rmdir', path, resource.kind, 0, start)
    await this.firePostOps('rmdir', path, pathSpec, true, null)
  }

  async rename(src: string, dst: string): Promise<void> {
    const start = Date.now()
    src = this.follow('rename', src)
    dst = this.follow('rename', dst)
    const [resource, srcSpec] = await this.resolver(src)
    const [, dstSpec] = await this.resolver(dst)
    await this.firePreOps('rename', src, srcSpec, true)
    await this.ops.call(
      'rename',
      resource.kind,
      resource.accessor ?? NOOP_ACCESSOR_INSTANCE,
      srcSpec,
      [dstSpec],
    )
    await this.record('rename', src, resource.kind, 0, start)
    await this.firePostOps('rename', src, srcSpec, true, null)
  }

  async cat(path: string): Promise<string> {
    return this.readFileText(path)
  }

  async listFiles(path: string): Promise<string[]> {
    const entries = await this.readdir(path)
    const files: string[] = []
    for (const fullPath of entries) {
      if (await this.isFile(fullPath)) {
        files.push(fullPath.slice(fullPath.lastIndexOf('/') + 1))
      }
    }
    return files
  }
}
