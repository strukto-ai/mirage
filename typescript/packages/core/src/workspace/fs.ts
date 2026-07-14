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
import { getExtension } from '../commands/resolve.ts'
import { OpRecord } from '../observe/record.ts'
import { NO_FOLLOW_OPS, type NamespaceLinks, type StatOverlay } from '../ops/config.ts'
import type { OpKwargs, OpsRegistry } from '../ops/registry.ts'
import type { Resource } from '../resource/base.ts'
import type { FileStat, MountMode, PathSpec } from '../types.ts'
import { FileType } from '../types.ts'

const NOOP_ACCESSOR_INSTANCE = new NOOPAccessor()

export type Resolver = (path: string) => Promise<[Resource, PathSpec, MountMode]>

export type OpSink = (rec: OpRecord) => Promise<void>

export class WorkspaceFS {
  private readonly resolver: Resolver
  private readonly ops: OpsRegistry
  private readonly sink: OpSink | null
  // Injected namespace seam (workspace wires it); FUSE reads `links` for
  // its symlink surface, and every op here follows links before resolving
  // so the facade and dispatch can never disagree on the operand.
  readonly links: NamespaceLinks | null
  private readonly statOverlay: StatOverlay | null

  constructor(
    resolver: Resolver,
    ops: OpsRegistry,
    sink: OpSink | null = null,
    links: NamespaceLinks | null = null,
    statOverlay: StatOverlay | null = null,
  ) {
    this.resolver = resolver
    this.ops = ops
    this.sink = sink
    this.links = links
    this.statOverlay = statOverlay
  }

  private follow(op: string, path: string): string {
    if (this.links === null || NO_FOLLOW_OPS.has(op)) return path
    return this.links.follow(path)
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
    const result = (await this.ops.call(
      'read',
      resource.kind,
      resource.accessor ?? NOOP_ACCESSOR_INSTANCE,
      pathSpec,
      [],
      kwargs,
    )) as Uint8Array
    await this.record('read', path, resource.kind, result.byteLength, start)
    return result
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
    await this.ops.call(
      'write',
      resource.kind,
      resource.accessor ?? NOOP_ACCESSOR_INSTANCE,
      pathSpec,
      [bytes],
      kwargs,
    )
    await this.record('write', path, resource.kind, bytes.byteLength, start)
  }

  async readdir(path: string): Promise<string[]> {
    const start = Date.now()
    path = this.follow('readdir', path)
    const [resource, pathSpec] = await this.resolver(path)
    const kwargs = resource.index !== undefined ? { index: resource.index } : {}
    const result = (await this.ops.call(
      'readdir',
      resource.kind,
      resource.accessor ?? NOOP_ACCESSOR_INSTANCE,
      pathSpec,
      [],
      kwargs,
    )) as string[] | null
    await this.record('readdir', path, resource.kind, 0, start)
    return result ?? []
  }

  async stat(path: string): Promise<FileStat> {
    const start = Date.now()
    path = this.follow('stat', path)
    const [resource, pathSpec] = await this.resolver(path)
    const kwargs = resource.index !== undefined ? { index: resource.index } : {}
    const result = (await this.ops.call(
      'stat',
      resource.kind,
      resource.accessor ?? NOOP_ACCESSOR_INSTANCE,
      pathSpec,
      [],
      kwargs,
    )) as FileStat
    await this.record('stat', path, resource.kind, 0, start)
    if (this.statOverlay !== null) return this.statOverlay(path, result)
    return result
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.stat(path)
      return true
    } catch {
      return false
    }
  }

  async isDir(path: string): Promise<boolean> {
    try {
      const s = await this.stat(path)
      return s.type === FileType.DIRECTORY
    } catch {
      return false
    }
  }

  async isFile(path: string): Promise<boolean> {
    try {
      const s = await this.stat(path)
      return s.type !== FileType.DIRECTORY
    } catch {
      return false
    }
  }

  async mkdir(path: string): Promise<void> {
    const start = Date.now()
    path = this.follow('mkdir', path)
    const [resource, pathSpec] = await this.resolver(path)
    await this.ops.call(
      'mkdir',
      resource.kind,
      resource.accessor ?? NOOP_ACCESSOR_INSTANCE,
      pathSpec,
    )
    await this.record('mkdir', path, resource.kind, 0, start)
  }

  async unlink(path: string): Promise<void> {
    const start = Date.now()
    path = this.follow('unlink', path)
    const [resource, pathSpec] = await this.resolver(path)
    await this.ops.call(
      'unlink',
      resource.kind,
      resource.accessor ?? NOOP_ACCESSOR_INSTANCE,
      pathSpec,
    )
    await this.record('unlink', path, resource.kind, 0, start)
  }

  async rmdir(path: string): Promise<void> {
    const start = Date.now()
    path = this.follow('rmdir', path)
    const [resource, pathSpec] = await this.resolver(path)
    await this.ops.call(
      'rmdir',
      resource.kind,
      resource.accessor ?? NOOP_ACCESSOR_INSTANCE,
      pathSpec,
    )
    await this.record('rmdir', path, resource.kind, 0, start)
  }

  async rename(src: string, dst: string): Promise<void> {
    const start = Date.now()
    src = this.follow('rename', src)
    dst = this.follow('rename', dst)
    const [resource, srcSpec] = await this.resolver(src)
    const [, dstSpec] = await this.resolver(dst)
    await this.ops.call(
      'rename',
      resource.kind,
      resource.accessor ?? NOOP_ACCESSOR_INSTANCE,
      srcSpec,
      [dstSpec],
    )
    await this.record('rename', src, resource.kind, 0, start)
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
