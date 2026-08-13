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

import { OpReport } from '../io/types.ts'
import { OpRecord } from '../observe/record.ts'
import { NO_FOLLOW_OPS, type NamespaceLinks } from './config.ts'
import type { OpKwargs } from './registry.ts'
import type { FileStat } from '../types.ts'
import { FileType, PathSpec } from '../types.ts'
import { exdev, isMissingPath } from '../utils/errors.ts'
import type { DispatchFn } from '../runtime/types.ts'

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
 * keeps only what is its own: the typed surface and the op ledger
 * (`records`, with the network/cache split derived from it) — the
 * ledger lives here, not on the workspace, which is what lets
 * `MountCore` take one `Ops` instead of reaching through a whole
 * `Workspace`. Mirrors Python's `Ops`.
 */
export class Ops {
  private readonly dispatch: DispatchFn
  private readonly sink: OpSink | null
  // Injected namespace seam (workspace wires it); FUSE reads `links`
  // for its symlink surface.
  readonly links: NamespaceLinks | null
  private readonly ownerOf: OwnerOf
  /**
   * The op ledger: every facade op lands here, and the executor
   * appends each shell line's ops too, so this is the one
   * workspace-wide account (python's `Ops.records`).
   */
  readonly records: OpRecord[] = []

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

  /** Ops that moved bytes over the network, in arrival order. */
  get networkRecords(): OpRecord[] {
    return this.records.filter((r) => !r.isCache)
  }

  get networkBytes(): number {
    let total = 0
    for (const r of this.records) if (!r.isCache) total += r.bytes
    return total
  }

  /** Ops a warm cache answered, in arrival order. */
  get cacheRecords(): OpRecord[] {
    return this.records.filter((r) => r.isCache)
  }

  get cacheBytes(): number {
    let total = 0
    for (const r of this.records) if (r.isCache) total += r.bytes
    return total
  }

  private async record(
    op: string,
    path: string,
    source: string,
    bytes: number,
    startMs: number,
  ): Promise<void> {
    const rec = new OpRecord({
      op,
      path,
      source,
      bytes,
      timestamp: Date.now(),
      durationMs: Date.now() - startMs,
    })
    this.records.push(rec)
    if (this.sink !== null) await this.sink(rec)
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
    const report = new OpReport()
    let result: unknown
    try {
      const [value] = await this.dispatch(op, PathSpec.fromStrPath(followed), args, kwargs, report)
      result = value
    } catch (err) {
      // Anything thrown after the op ran (a postOps deny, a hard
      // output cap, a bookkeeping failure) suppresses the result, not
      // the effect, so observation must reflect the op before the
      // error propagates. The door stamps the report at the moment of
      // completion, so even a foreign error the door never defined
      // leaves the transfer on the books.
      if (report.completed && owner !== null) {
        await this.recordOp(op, followed, owner, report.source, report.bytes, null, args, start)
      }
      throw err
    }
    if (owner !== null) {
      await this.recordOp(op, followed, owner, report.source, report.bytes, result, args, start)
    }
    return result
  }

  /**
   * Record one op from the door's report of who served it.
   *
   * The door names the server when it was not the owning mount (a warm
   * cache hit, a synthetic namespace answer): neither moved bytes over
   * the network, and 'ram' is what OpRecord.isCache reads. It names the
   * moved bytes when the delivered result no longer measures them,
   * because a cap truncated it or a refusal withheld it entirely.
   */
  private async recordOp(
    op: string,
    path: string,
    owner: MountOwner,
    source: string | null,
    moved: number | null,
    result: unknown,
    args: readonly unknown[],
    start: number,
  ): Promise<void> {
    await this.record(op, path, source ?? owner.kind, moved ?? payloadBytes(result, args), start)
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

  /**
   * Append bytes to a file through the mount's append op (the python
   * facade's `append`). No whole-file fallback here: that is
   * RuntimeVFS's business, where a guest holds the full buffer; an
   * embedder calling the facade gets the mount's real answer.
   */
  async append(path: string, data: Uint8Array): Promise<void> {
    await this.through('append', path, [data])
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
