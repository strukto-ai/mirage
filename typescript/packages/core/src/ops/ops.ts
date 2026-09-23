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

import { type IOResult, OpReport } from '../io/types.ts'
import type { OpRecord } from '../observe/record.ts'
import { finishRecord, type OpTimer, startOp } from '../observe/context.ts'
import { NO_FOLLOW_OPS, type NamespaceLinks } from './config.ts'
import type { OpKwargs } from './registry.ts'
import type { FileStat, SetAttrFields } from '../types.ts'
import { FileType, PathSpec } from '../types.ts'
import { exdev, isMissingPath } from '../utils/errors.ts'
import type { DispatchFn } from '../runtime/types.ts'
import { getCurrentSession, pathAllowed } from '../context/session_context.ts'

/** Receives each record with the id of the session the op ran as. */
export type OpSink = (rec: OpRecord, sessionId: string) => Promise<void>

interface MountOwner {
  readonly prefix: string
  readonly kind: string
}

export type OwnerOf = (path: string) => MountOwner | null

/**
 * Run one facade op as a session: `(sessionId, run) => result`, null
 * naming the workspace's default session as it is when the op runs.
 * The workspace supplies it, so the facade binds the session the way a
 * shell line does without holding the session manager itself.
 */
export type SessionBind = <T>(sessionId: string | null, run: () => Promise<T>) => Promise<T>

/** What a derived facade carries over and a constructor may set. */
export interface OpsOptions {
  bind?: SessionBind | null
  sessionId?: string | null
  records?: OpRecord[]
}

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
 * Every op delegates to the workspace dispatcher, so `ws.vfs` walks the
 * same pipeline as a shell command: link follow, session grants,
 * admission policies, cache read-through, namespace structure, and
 * post-write invalidation all fire once, at that one door. The facade
 * keeps only what is its own: the typed surface and the op ledger
 * (`records`, with the network/cache split derived from it) — the
 * ledger lives here, not on the workspace, which is what lets
 * `MountCore` take one `Ops` instead of reaching through a whole
 * `Workspace`. Mirrors Python's `Ops`.
 *
 * The facade runs as one session, `sessionId`, through `bind`: every
 * op is judged under that session's profile (hides, mount modes,
 * grants) exactly as a shell line in it would be, so an agent whose
 * file tool reads through `ws.vfs` is confined the way its shell is.
 * null names the workspace's default session as it is when the op
 * runs, since a snapshot load can rename it. A session already bound
 * when the op arrives (a command's own runtime, a kernel mount serving
 * one session) is kept, so the facade never widens the caller's view,
 * and the record names the session that judged the op. `Session`
 * derives a facade for another session over the same ledger.
 *
 * Every op also takes a trailing `sessionId` for the one-call case,
 * the way `Workspace.shell` does. One rule decides between them: a
 * shell line *sets* the session, an op *inherits* it. So the argument
 * is the session to run as when no line is already running, and the
 * line's session wins when one is, which is what keeps a handler
 * reaching this door from widening the view it was given.
 */
export class Ops {
  private readonly dispatch: DispatchFn
  private readonly sink: OpSink | null
  // Injected namespace seam (workspace wires it); FUSE reads `links`
  // for its symlink surface.
  readonly links: NamespaceLinks | null
  private readonly ownerOf: OwnerOf
  private readonly bind: SessionBind | null
  /** The session this facade runs as; null for the workspace's default. */
  readonly sessionId: string | null
  /**
   * The op ledger: every facade op lands here, and the executor
   * appends each shell line's ops too, so this is the one
   * workspace-wide account (python's `Ops.records`).
   */
  readonly records: OpRecord[]

  constructor(
    dispatch: DispatchFn,
    sink: OpSink | null = null,
    links: NamespaceLinks | null = null,
    ownerOf: OwnerOf = () => null,
    options: OpsOptions = {},
  ) {
    this.dispatch = dispatch
    this.sink = sink
    this.links = links
    this.ownerOf = ownerOf
    this.bind = options.bind ?? null
    this.sessionId = options.sessionId ?? null
    this.records = options.records ?? []
  }

  /**
   * The same facade run as another session, over the same ledger, so
   * the workspace-wide account stays one list.
   *
   * @internal The mechanism behind `Session.vfs`, not a door of
   * its own: a host binds a session with `ws.session(id)` (creating it
   * when the id is new) or `new Session(ws, id)` (adopting one
   * that exists), so there is one way to say it rather than two.
   * TypeScript has no package-private, so this stays reachable; it is
   * not part of the supported surface. Python spells it
   * `Ops._for_session`.
   */
  forSession(sessionId: string): Ops {
    return new Ops(this.dispatch, this.sink, this.links, this.ownerOf, {
      bind: this.bind,
      sessionId,
      records: this.records,
    })
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
    timer: OpTimer,
    session: string,
  ): Promise<void> {
    const rec = finishRecord(op, path, source, bytes, timer)
    this.records.push(rec)
    if (this.sink !== null) await this.sink(rec, session)
  }

  /**
   * Run one op through the workspace dispatcher and record it.
   *
   * The door owns the whole pipeline (follow, grants, gates, cache,
   * structure, invalidation); the facade's own share is the record. The
   * path is link-followed here first so the record carries the resolved
   * path; the door's second follow of an already-resolved path is a
   * no-op. That follow runs inside the session binding and only from a
   * path the session can see: a link the session cannot see stays the
   * typed path, so the door refuses it as absent instead of serving the
   * visible target it points at. Mirrors Python's Ops._call.
   */
  private async through(
    op: string,
    path: string,
    args: readonly unknown[] = [],
    kwargs: OpKwargs = {},
    sessionId?: string,
  ): Promise<unknown> {
    const timer = startOp()
    // `nofollow` is the caller's AT_SYMLINK_NOFOLLOW and suppresses
    // both follows, so an op meant for a link entry itself (chmod -h, a
    // guest's lchown) still records the link's own path.
    const links = NO_FOLLOW_OPS.has(op) || kwargs.nofollow === true ? null : this.links
    let followed = path
    const report = new OpReport()
    // The record names the session the op ran as: noted inside the
    // bind, since the facade's own id may be null (the default) and a
    // session bound by the caller is kept over it.
    let seen: string | null = null
    const run = (): Promise<[unknown, IOResult]> => {
      seen = getCurrentSession()?.sessionId ?? null
      if (links !== null && pathAllowed(path)) followed = links.follow(path)
      return this.dispatch(op, PathSpec.fromStrPath(followed), args, kwargs, report)
    }
    let result: unknown
    let owner: MountOwner | null = null
    try {
      const bound = sessionId ?? this.sessionId
      const [value] = await (this.bind === null ? run() : this.bind(bound, run))
      result = value
      owner = this.ownerOf(followed)
    } catch (err) {
      owner = this.ownerOf(followed)
      // Anything thrown after the op ran (a postOps deny, a hard
      // output cap, a bookkeeping failure) suppresses the result, not
      // the effect, so observation must reflect the op before the
      // error propagates. The door stamps the report at the moment of
      // completion, so even a foreign error the door never defined
      // leaves the transfer on the books.
      if (report.completed && owner !== null) {
        await this.recordOp(
          op,
          followed,
          owner,
          report.source,
          report.bytes,
          null,
          args,
          timer,
          this.sessionFor(seen),
        )
      }
      throw err
    }
    if (owner !== null) {
      await this.recordOp(
        op,
        followed,
        owner,
        report.source,
        report.bytes,
        result,
        args,
        timer,
        this.sessionFor(seen),
      )
    }
    return result
  }

  /** The session id a record carries: the one the op ran as, else this
   * facade's own, else the unbound door's empty id. */
  private sessionFor(seen: string | null): string {
    return seen ?? this.sessionId ?? ''
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
    timer: OpTimer,
    session: string,
  ): Promise<void> {
    await this.record(
      op,
      path,
      source ?? owner.kind,
      moved ?? payloadBytes(result, args),
      timer,
      session,
    )
  }

  // `raw` skips the filetype cascade: an explicit null filetype stops
  // the door from stamping the path's extension, so a rendered read op
  // (gdoc/gsheet/gmail) is bypassed and the stored bytes come back.
  // `offset`/`size` ride the same kwargs the generic read op already reads,
  // so a backend with a native range fetches one window instead of the whole
  // object. Python spells this `read(path, offset, size, raw)`.
  async readFile(
    path: string,
    options: { raw?: boolean; offset?: number; size?: number | null } = {},
    sessionId?: string,
  ): Promise<Uint8Array> {
    const kwargs: OpKwargs = options.raw === true ? { filetype: null } : {}
    const offset = options.offset ?? 0
    const size = options.size ?? null
    if (offset !== 0 || size !== null) {
      return (await this.through(
        'read',
        path,
        [],
        { ...kwargs, offset, size },
        sessionId,
      )) as Uint8Array
    }
    return (await this.through('read', path, [], kwargs, sessionId)) as Uint8Array
  }

  async readFileText(path: string, encoding = 'utf-8', sessionId?: string): Promise<string> {
    const bytes = await this.readFile(path, {}, sessionId)
    return new TextDecoder(encoding, { fatal: false }).decode(bytes)
  }

  async writeFile(path: string, data: Uint8Array | string, sessionId?: string): Promise<void> {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
    await this.through('write', path, [bytes], {}, sessionId)
  }

  /**
   * Append bytes to a file through the mount's append op (the python
   * facade's `append`). No whole-file fallback here: that is
   * RuntimeVFS's business, where a guest holds the full buffer; an
   * embedder calling the facade gets the mount's real answer.
   */
  async append(path: string, data: Uint8Array, sessionId?: string): Promise<void> {
    await this.through('append', path, [data], {}, sessionId)
  }

  async readdir(path: string, sessionId?: string): Promise<string[]> {
    return ((await this.through('readdir', path, [], {}, sessionId)) as string[] | null) ?? []
  }

  async stat(path: string, sessionId?: string): Promise<FileStat> {
    return (await this.through('stat', path, [], {}, sessionId)) as FileStat
  }

  // The three probes below answer "is this path there?", so only a genuine
  // missing path may read back as false. An auth failure, a timeout, or a
  // backend bug is not an answer to that question: swallowing it would let a
  // caller act on a false "missing" (overwrite, recreate, skip). Mirrors
  // Python's `(FileNotFoundError, ValueError)` swallow set.
  async exists(path: string, sessionId?: string): Promise<boolean> {
    try {
      await this.stat(path, sessionId)
      return true
    } catch (err) {
      if (isMissingPath(err)) return false
      throw err
    }
  }

  async isDir(path: string, sessionId?: string): Promise<boolean> {
    try {
      const s = await this.stat(path, sessionId)
      return s.type === FileType.DIRECTORY
    } catch (err) {
      if (isMissingPath(err)) return false
      throw err
    }
  }

  async isFile(path: string, sessionId?: string): Promise<boolean> {
    try {
      const s = await this.stat(path, sessionId)
      return s.type !== FileType.DIRECTORY
    } catch (err) {
      if (isMissingPath(err)) return false
      throw err
    }
  }

  async mkdir(path: string, sessionId?: string): Promise<void> {
    await this.through('mkdir', path, [], {}, sessionId)
  }

  async create(path: string, sessionId?: string): Promise<void> {
    await this.through('create', path, [], {}, sessionId)
  }

  /**
   * Create a namespace symlink at `path`.
   *
   * Routed through the door like every write: session grants and
   * admission policies fire on the link's turf, and the write lands on
   * the ledger. The target is stored verbatim as typed. Throws EEXIST
   * when something is already at `path` (a file, a directory, another
   * link, a mount root): symlink(2) never overwrites, and the door is
   * the layer that can see both planes to tell. Mirrors Python's
   * Ops.symlink.
   */
  async symlink(path: string, target: string, sessionId?: string): Promise<void> {
    await this.through('symlink', path, [], { target }, sessionId)
  }

  /** The stored target of the link at `path`; EINVAL when not a link. */
  async readlink(path: string, sessionId?: string): Promise<string> {
    return (await this.through('readlink', path, [], {}, sessionId)) as string
  }

  /**
   * Write metadata fields, natively where the backend can hold them.
   *
   * Every field is passed, unset ones as undefined, because the door
   * reads the whole set and stores in the namespace overlay whatever
   * the backend cannot keep. A mount with no setattr op therefore still
   * answers: a chmod on an s3 or dropbox mount lands in the name plane
   * and stat reports it back. Stored, not enforced; the mount mode is
   * the access control. Returns what the backend could not keep.
   * Mirrors Python's Ops.setattr.
   */
  async setattr(
    path: string,
    attrs: SetAttrFields = {},
    sessionId?: string,
  ): Promise<Record<string, number | string>> {
    const { nofollow = false, ...fields } = attrs
    return (await this.through('setattr', path, [], { ...fields, nofollow }, sessionId)) as Record<
      string,
      number | string
    >
  }

  /**
   * One extended attribute's value. The node table answers with what a
   * caller set. `nofollow` reads a link entry's own
   * attributes. Throws ENODATA when the path has no such attribute.
   * Mirrors Python's Ops.getxattr.
   */
  async getxattr(
    path: string,
    name: string,
    opts: { nofollow?: boolean } = {},
    sessionId?: string,
  ): Promise<Uint8Array> {
    const kwargs = { name, nofollow: opts.nofollow === true }
    return (await this.through('getxattr', path, [], kwargs, sessionId)) as Uint8Array
  }

  /** Every extended attribute name a path carries, sorted. */
  async listxattr(
    path: string,
    opts: { nofollow?: boolean } = {},
    sessionId?: string,
  ): Promise<string[]> {
    const kwargs = { nofollow: opts.nofollow === true }
    return (await this.through('listxattr', path, [], kwargs, sessionId)) as string[]
  }

  /**
   * Store an extended attribute on a path's namespace node, so it works
   * on every backend and moves with a rename. `create` refuses with
   * EEXIST when it is set (XATTR_CREATE) and `replace` with ENODATA when
   * it is not (XATTR_REPLACE).
   * Mirrors Python's Ops.setxattr.
   */
  async setxattr(
    path: string,
    name: string,
    value: Uint8Array,
    opts: { create?: boolean; replace?: boolean; nofollow?: boolean } = {},
    sessionId?: string,
  ): Promise<void> {
    const kwargs = {
      name,
      value,
      create: opts.create === true,
      replace: opts.replace === true,
      nofollow: opts.nofollow === true,
    }
    await this.through('setxattr', path, [], kwargs, sessionId)
  }

  /** Drop an extended attribute; ENODATA when it is not set. */
  async removexattr(
    path: string,
    name: string,
    opts: { nofollow?: boolean } = {},
    sessionId?: string,
  ): Promise<void> {
    await this.through(
      'removexattr',
      path,
      [],
      { name, nofollow: opts.nofollow === true },
      sessionId,
    )
  }

  async truncate(path: string, length: number, sessionId?: string): Promise<void> {
    await this.through('truncate', path, [length], {}, sessionId)
  }

  async unlink(path: string, sessionId?: string): Promise<void> {
    await this.through('unlink', path, [], {}, sessionId)
  }

  async rmdir(path: string, sessionId?: string): Promise<void> {
    await this.through('rmdir', path, [], {}, sessionId)
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
  async rename(src: string, dst: string, sessionId?: string): Promise<void> {
    if ((this.ownerOf(src)?.prefix ?? '') !== (this.ownerOf(dst)?.prefix ?? '')) {
      throw exdev(src)
    }
    await this.through('rename', src, [PathSpec.fromStrPath(dst)], {}, sessionId)
  }

  async cat(path: string, sessionId?: string): Promise<string> {
    return this.readFileText(path, 'utf-8', sessionId)
  }

  async listFiles(path: string, sessionId?: string): Promise<string[]> {
    const entries = await this.readdir(path, sessionId)
    const files: string[] = []
    for (const fullPath of entries) {
      if (await this.isFile(fullPath, sessionId)) {
        files.push(fullPath.slice(fullPath.lastIndexOf('/') + 1))
      }
    }
    return files
  }
}
