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

import { OpRecord } from '../observe/record.ts'
import { NO_FOLLOW_OPS, type NamespaceLinks } from '../ops/config.ts'
import type { OpKwargs } from '../ops/registry.ts'
import { PolicyDenied } from '../policy/errors.ts'
import type { FileStat } from '../types.ts'
import { FileType, PathSpec, ResourceName } from '../types.ts'
import { exdev, isMissingPath } from '../utils/errors.ts'
import type { DispatchFn } from './executor/cross_mount.ts'

export type OpSink = (rec: OpRecord) => Promise<void>

interface MountOwner {
  readonly prefix: string
  readonly kind: string
}

export type OwnerOf = (path: string) => MountOwner | null

// The op's byte count for recording: the result first, else the input
// (write payloads travel as the first positional argument). Mirrors
// Python's Ops._payload_bytes.
function payloadBytes(result: unknown, args: readonly unknown[]): number {
  if (result instanceof Uint8Array) return result.byteLength
  for (const arg of args) {
    if (arg instanceof Uint8Array) return arg.byteLength
  }
  return 0
}

/**
 * The typed op facade FUSE and programmatic embedders call.
 *
 * Every op delegates to the workspace dispatcher, so `ws.fs` walks the
 * same pipeline as a shell command: link follow, session grants,
 * admission policies, cache read-through, namespace structure, and
 * post-write invalidation all fire once, at that one door. The facade
 * keeps only what is its own: the typed surface and op recording
 * (`ws.records`, and the network/cache split derived from it). Mirrors
 * Python's `Ops` attached to a workspace.
 */
export class WorkspaceFS {
  private readonly dispatch: DispatchFn
  private readonly sink: OpSink | null
  // Injected namespace seam (workspace wires it); FUSE reads `links`
  // for its symlink surface.
  readonly links: NamespaceLinks | null
  private readonly ownerOf: OwnerOf

  constructor(
    dispatch: DispatchFn,
    sink: OpSink | null = null,
    links: NamespaceLinks | null = null,
    ownerOf: OwnerOf = () => null,
  ) {
    this.dispatch = dispatch
    this.sink = sink
    this.links = links
    this.ownerOf = ownerOf
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

  /**
   * Run one op through the workspace dispatcher and record it.
   *
   * The door owns the whole pipeline (follow, grants, gates, cache,
   * structure, invalidation); the facade's own share is the record. The
   * path is link-followed here first so the record carries the resolved
   * path; the door's second follow of an already-resolved path is a
   * no-op. Mirrors Python's Ops._through_door.
   */
  private async through(
    op: string,
    path: string,
    args: readonly unknown[] = [],
    kwargs: OpKwargs = {},
  ): Promise<unknown> {
    const start = Date.now()
    const followed = this.links !== null && !NO_FOLLOW_OPS.has(op) ? this.links.follow(path) : path
    const owner = this.ownerOf(followed)
    let result: unknown
    let servedBy: string | null = null
    let moved: number | null = null
    try {
      const [value, io] = await this.dispatch(op, PathSpec.fromStrPath(followed), args, kwargs)
      result = value
      servedBy = io.opSource
      moved = io.opBytes
    } catch (err) {
      // A postOps deny suppresses the result, not the effect: the
      // backend already ran, so observation must reflect the op before
      // the deny propagates. The suppressed result is gone, so a read's
      // byte count rides on the exception; a write's is still in its
      // own arguments.
      if (err instanceof PolicyDenied && err.completed && owner !== null) {
        const nbytes = err.completedBytes || payloadBytes(null, args)
        const source = err.fromCache ? ResourceName.RAM : owner.kind
        await this.record(op, followed, source, nbytes, start)
      }
      throw err
    }
    if (owner !== null) {
      // The door names the server when it is not the owning mount (a
      // warm cache hit, a synthetic namespace answer): neither moved
      // bytes over the network, and 'ram' is what OpRecord.isCache
      // reads. It reports opBytes when a postOps limit truncated the
      // result, since the transfer had already happened by then.
      const source = servedBy ?? owner.kind
      const nbytes = moved ?? payloadBytes(result, args)
      await this.record(op, followed, source, nbytes, start)
    }
    return result
  }

  // `raw` skips the filetype cascade: an explicit null filetype stops
  // the door from stamping the path's extension, so a rendered read op
  // (gdoc/gsheet/gmail) is bypassed and the stored bytes come back.
  async readFile(path: string, options: { raw?: boolean } = {}): Promise<Uint8Array> {
    const kwargs: OpKwargs = options.raw === true ? { filetype: null } : {}
    return (await this.through('read', path, [], kwargs)) as Uint8Array
  }

  async readFileText(path: string, encoding = 'utf-8'): Promise<string> {
    const bytes = await this.readFile(path)
    return new TextDecoder(encoding, { fatal: false }).decode(bytes)
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
    await this.through('write', path, [bytes])
  }

  async readdir(path: string): Promise<string[]> {
    return ((await this.through('readdir', path)) as string[] | null) ?? []
  }

  async stat(path: string): Promise<FileStat> {
    return (await this.through('stat', path)) as FileStat
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
    await this.through('mkdir', path)
  }

  async create(path: string): Promise<void> {
    await this.through('create', path)
  }

  async truncate(path: string, length: number): Promise<void> {
    await this.through('truncate', path, [length])
  }

  async unlink(path: string): Promise<void> {
    await this.through('unlink', path)
  }

  async rmdir(path: string): Promise<void> {
    await this.through('rmdir', path)
  }

  /**
   * Rename a file or directory within one mount.
   *
   * Both ends must resolve to the same mount: a mount is a filesystem
   * boundary, and the facade is where a kernel-facing whole-workspace
   * FUSE mount needs the refusal, so `mv` between two backends falls
   * back to its copy+unlink path instead of corrupting one backend's
   * key space with the other's path. Mirrors Python's Ops.rename.
   */
  async rename(src: string, dst: string): Promise<void> {
    if ((this.ownerOf(src)?.prefix ?? '') !== (this.ownerOf(dst)?.prefix ?? '')) {
      throw exdev(src)
    }
    await this.through('rename', src, [PathSpec.fromStrPath(dst)])
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
