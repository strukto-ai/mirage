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

import { classify } from '../errors/classify.ts'
import { ebadf, eexist, efbig } from '../errors/fs.ts'
import { registerPipeServer } from '../machine/mounts.ts'
import { PolicyDenied } from '../policy/errors.ts'
import { READ, type OpenMode } from '../runtime/handles/index.ts'
import type { PipeWriter } from '../runtime/types.ts'
import { concat } from '../utils/bytes.ts'
import { posixNormpath } from '../utils/path.ts'
import { S_IFDIR, S_IFMT, S_IFREG } from '../utils/stat_view.ts'
import { readerOf, type Files } from '../workspace/files.ts'
import type { SessionState } from '../workspace/session/session.ts'
import {
  FSPROTO_FETCH_DIR_BYTES,
  FSPROTO_FETCH_FILE_BYTES,
  FSPROTO_FRAME_BYTES,
  FSPROTO_KEPT,
  FSPROTO_TREE_ENTRIES,
  FSPROTO_VERSION,
  FSPROTO_WHOLE_BYTES,
} from './constants.ts'
import { MountCore } from './core.ts'
import { messageCondition } from './errors.ts'
import type { MountAttrs, ServedPrefix } from './types.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const EMPTY = new Uint8Array(0)
// How long a barrier waits for the machine's answer before the line runs anyway.
const BEGIN_WAIT_SECONDS = 15

type Head = Record<string, unknown>

/** One fsproto frame: its JSON header and its raw body. */
export interface Frame {
  head: Head
  body: Uint8Array
}

/**
 * `head` and `body` as one frame: a big-endian u32 length, a big-endian u32
 * header length, the JSON header and the body. Mirrors mirage-fuse's
 * `proto::encode` and Python's `encode_frame`.
 */
export function encodeFrame(head: Head, body: Uint8Array = EMPTY): Uint8Array {
  const json = ENC.encode(JSON.stringify(head))
  const total = 4 + json.byteLength + body.byteLength
  const out = new Uint8Array(4 + total)
  const view = new DataView(out.buffer)
  view.setUint32(0, total)
  view.setUint32(4, json.byteLength)
  out.set(json, 8)
  out.set(body, 8 + json.byteLength)
  return out
}

/** The frames in a byte stream, as its chunks arrive. */
export class FrameReader {
  private buf: Uint8Array = EMPTY

  /** Every frame `chunk` completes; throws on a frame no client sends. */
  push(chunk: Uint8Array): Frame[] {
    this.buf = this.buf.byteLength === 0 ? chunk : concat([this.buf, chunk])
    const out: Frame[] = []
    for (;;) {
      if (this.buf.byteLength < 4) break
      const view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength)
      const total = view.getUint32(0)
      if (total < 4 || total > FSPROTO_FRAME_BYTES)
        throw new Error('fsproto: a frame of impossible size')
      if (this.buf.byteLength < 4 + total) break
      const headLength = view.getUint32(4)
      if (4 + headLength > total) throw new Error('fsproto: a header past its frame')
      const head: unknown = JSON.parse(DEC.decode(this.buf.subarray(8, 8 + headLength)))
      if (head === null || typeof head !== 'object' || Array.isArray(head)) {
        throw new Error('fsproto: a header that is not an object')
      }
      out.push({ head: head as Head, body: this.buf.slice(8 + headLength, 4 + total) })
      this.buf = this.buf.subarray(4 + total)
    }
    return out
  }
}

/** A client path as a workspace path: absolute, normalized, never above `/`. */
function workspacePath(path: unknown): string {
  return posixNormpath('/' + (typeof path === 'string' ? path : ''))
}

/** A listing without `.` and `..`, which the client adds itself. */
function shown(rows: [string, MountAttrs][]): [string, MountAttrs][] {
  return rows.filter(([name]) => name !== '.' && name !== '..')
}

function child(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`
}

/** Whether a change at `path` reaches what is under `prefix`. */
function overlaps(path: string, prefix: string): boolean {
  const a = path.replace(/\/+$/, '')
  const b = prefix.replace(/\/+$/, '')
  return a === b || b.startsWith(`${a}/`) || a.startsWith(`${b}/`)
}

/** Attributes as fsproto carries them, times in milliseconds. */
export function wire(a: MountAttrs): Head {
  return {
    m: a.mode,
    s: a.size,
    a: a.atime.getTime(),
    t: a.mtime.getTime(),
    c: a.ctime.getTime(),
    n: a.nlink,
    r: a.rdev,
  }
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** A request's integer field, `fallback` when it sent none. */
function whole(value: unknown, fallback: number): number {
  return Math.trunc(num(value) ?? fallback)
}

function condition(err: unknown): string {
  if (err instanceof PolicyDenied && err.decision !== null) {
    console.info(`policy ${err.decision.policy} refused ${err.virtualPath}: ${err.decision.reason}`)
  }
  const named = classify(err) ?? messageCondition(err)
  if (named === null) console.warn(`unclassified mount error: ${String(err)}`)
  return named ?? 'EIO'
}

/**
 * fsproto on a byte pipe as `session`, for a machine's mirage-fuse.
 *
 * Every request lands on one MountCore bound to the session, so the
 * machine sees exactly the tree, modes and policies a shell in that
 * session sees. Requests are answered one at a time in arrival order, as
 * SFTP's are, so a release never overtakes the writes it settles. Each
 * reply about a path says whether the client may keep it until told
 * otherwise (`k`): only for a backend nothing but the workspace changes
 * (`FSPROTO_KEPT`), whose every change this server pushes to the client as
 * it is noted, and `begin` waits until the client has applied them all.
 * Mirrors Python's `FsprotoServer`.
 */
export class FsprotoServer {
  private readonly core: MountCore
  private writer: PipeWriter | null = null
  private queue: Promise<void> = Promise.resolve()
  private lost = new Map<number, [string, unknown]>()
  private readonly told = new Set<number>()
  private readonly acks = new Map<number, () => void>()
  private readonly invalid = new Set<string>()
  private flushing = false
  private hid = 0
  private ended = false

  /**
   * @param run runs one request, with a line's write admission.
   * @param served the prefix the client mounts, its machine, and the
   *   workspace's changes, which reach the client as invalidations.
   */
  constructor(
    files: Files,
    session: SessionState,
    private readonly run: (op: () => Promise<void>) => Promise<void> = (op) => op(),
    private readonly served: ServedPrefix | null = null,
  ) {
    this.core = new MountCore(files, { session })
  }

  /** Answer the client's requests until it closes the pipe. */
  async serve(reader: ReadableStream<Uint8Array>, writer: PipeWriter): Promise<void> {
    this.writer = writer
    const served = this.served
    const unwatch =
      served?.changes?.watch((path, by) => {
        if (by === served.machine || !overlaps(path, served.prefix)) return
        this.invalid.add(path)
        if (!this.flushing) {
          this.flushing = true
          queueMicrotask(() => {
            this.flushing = false
            this.flush()
          })
        }
      }) ?? null
    const frames = new FrameReader()
    const chunks = reader.getReader()
    try {
      for (;;) {
        const { done, value } = await chunks.read()
        if (done) break
        for (const frame of frames.push(value)) this.take(frame)
      }
    } finally {
      unwatch?.()
      this.ended = true
      for (const ack of this.acks.values()) ack()
      this.acks.clear()
      this.queue = this.queue.then(() => this.exit())
      await this.queue
    }
  }

  /**
   * Resolve once the client has applied every change noted so far: the
   * barrier a line passes before its program starts. A client that does
   * not answer within BEGIN_WAIT_SECONDS is let go with a warning.
   */
  async begin(): Promise<void> {
    if (this.ended || this.writer === null) return
    this.flush()
    this.hid += 1
    const hid = this.hid
    let timer: ReturnType<typeof setTimeout> | undefined
    await new Promise<void>((resolve) => {
      this.acks.set(hid, resolve)
      timer = setTimeout(() => {
        if (!this.acks.delete(hid)) return
        console.warn(`mirage-fuse did not answer a barrier on ${this.served?.prefix ?? '/'}`)
        resolve()
      }, BEGIN_WAIT_SECONDS * 1000)
      this.send({ hid, op: 'begin' })
    })
    clearTimeout(timer)
  }

  /**
   * Land every write the client has been told is done, as SFTP's
   * PipeServer does.
   *
   * @returns the path and error of each landing that failed since the last
   *   sync, at a release or here.
   */
  async sync(): Promise<[string, unknown][]> {
    const failed = await this.core.sync()
    const lost = this.lost
    this.lost = new Map()
    for (const [fd, path, err] of failed) {
      if (this.told.has(fd)) continue
      this.told.add(fd)
      lost.set(fd, [path, err])
    }
    return [...lost.values()]
  }

  private send(head: Head, body: Uint8Array = EMPTY): void {
    if (this.writer === null || this.ended) return
    this.writer.write(encodeFrame(head, body))
  }

  private flush(): void {
    if (this.invalid.size === 0) return
    const paths = [...this.invalid]
    this.invalid.clear()
    this.send({ push: 'inval', paths })
  }

  private take(frame: Frame): void {
    const hid = num(frame.head.hid)
    if (hid !== null) {
      this.acks.get(hid)?.()
      this.acks.delete(hid)
      return
    }
    const id = num(frame.head.id)
    if (id === null) return
    this.queue = this.queue.then(async () => {
      let answer: [Head, Uint8Array] = [{}, EMPTY]
      try {
        await this.run(async () => {
          answer = await this.answer(frame)
        })
        this.send({ ...answer[0], id }, answer[1])
      } catch (err) {
        this.send({ id, errno: condition(err) })
      }
    })
  }

  /**
   * The listings of the kept folders under `root`, breadth first, until
   * they carry FSPROTO_TREE_ENTRIES entries. Mirrors Python's `_tree`.
   */
  private async tree(root: string, rows: [string, MountAttrs][]): Promise<[string, unknown[]][]> {
    const folders: [string, unknown[]][] = []
    let count = rows.length
    const isDir = (a: MountAttrs): boolean => (a.mode & S_IFMT) === S_IFDIR
    const queue = rows.filter(([, a]) => isDir(a)).map(([name]) => child(root, name))
    while (queue.length > 0 && count < FSPROTO_TREE_ENTRIES) {
      const folder = queue.shift()
      if (folder === undefined || !this.kept(folder)) continue
      let below: [string, MountAttrs][]
      try {
        below = shown(await this.core.listing(folder))
      } catch (err) {
        console.debug(`fsproto: listing ${folder} failed`, err)
        continue
      }
      folders.push([folder, below.map(([name, a]) => [name, wire(a)])])
      count += below.length
      for (const [name, a] of below) if (isDir(a)) queue.push(child(folder, name))
    }
    return folders
  }

  private kept(path: string): boolean {
    const row = readerOf(this.core.files).owner(path)
    return row !== null && FSPROTO_KEPT.includes(row.kind)
  }

  private pathOf(fd: number): string {
    const path = this.core.handles.get(fd)?.path
    if (path === undefined) throw ebadf(String(fd))
    return path
  }

  /** `path`'s attributes and whole content, read in one open. */
  private async whole(path: string): Promise<[MountAttrs, Uint8Array]> {
    const core = this.core
    const fd = await core.open(path, READ)
    try {
      const attrs = await core.fgetattr(path, fd)
      const parts: Uint8Array[] = []
      let at = 0
      for (;;) {
        const data = await core.read(path, fd, at, 1024 * 1024)
        if (data.byteLength === 0) break
        parts.push(data)
        at += data.byteLength
        if (at > FSPROTO_WHOLE_BYTES) throw efbig(path)
      }
      return [{ ...attrs, size: at }, concat(parts)]
    } finally {
      await core.release(fd)
    }
  }

  private async answer(frame: Frame): Promise<[Head, Uint8Array]> {
    const h = frame.head
    const core = this.core
    const path = workspacePath(h.path)
    switch (h.op) {
      case 'hello':
        return [{ proto: FSPROTO_VERSION }, EMPTY]
      case 'getattr':
        return [{ a: wire(await core.getattr(path)), k: this.kept(path) }, EMPTY]
      case 'list': {
        const kept = this.kept(path)
        const rows = shown(await core.listing(path))
        const head: Head = { e: rows.map(([name, a]) => [name, wire(a)]), k: kept }
        if (h.deep === true && kept) head.d = await this.tree(path, rows)
        return [head, EMPTY]
      }
      case 'fetchdir': {
        if (!this.kept(path)) return [{ k: false, f: [] }, EMPTY]
        const files: [string, Head][] = []
        const parts: Uint8Array[] = []
        let total = 0
        for (const [name, a] of await core.listing(path)) {
          if ((a.mode & S_IFMT) !== S_IFREG || a.size > FSPROTO_FETCH_FILE_BYTES) continue
          if (total + a.size > FSPROTO_FETCH_DIR_BYTES) continue
          try {
            const [now, data] = await this.whole(child(path, name))
            files.push([name, wire(now)])
            parts.push(data)
            total += data.byteLength
          } catch (err) {
            console.debug(`fsproto: prefetching ${child(path, name)} failed:`, err)
          }
        }
        return [{ k: true, f: files }, concat(parts)]
      }
      case 'readall': {
        const [a, data] = await this.whole(path)
        return [{ a: wire(a), k: this.kept(path) }, data]
      }
      case 'readlink':
        return [{ target: await core.readlink(path) }, EMPTY]
      case 'open': {
        const mode: OpenMode = {
          readable: h.read !== false,
          writable: h.write === true,
          truncate: h.truncate === true,
          append: h.append === true,
          create: false,
          exclusive: false,
          binary: true,
        }
        const fd = await core.open(path, mode)
        return [{ fh: fd, k: this.kept(path) }, EMPTY]
      }
      case 'create': {
        const mode: OpenMode = {
          readable: true,
          writable: true,
          truncate: false,
          append: false,
          create: true,
          exclusive: h.exclusive === true,
          binary: true,
        }
        const fd = await core.open(path, mode, num(h.mode))
        return [{ fh: fd, a: wire(await core.fgetattr(path, fd)), k: this.kept(path) }, EMPTY]
      }
      case 'read': {
        const fd = whole(h.fh, -1)
        const data = await core.read(this.pathOf(fd), fd, whole(h.offset, 0), whole(h.size, 0))
        return [{}, data]
      }
      case 'write': {
        const fd = whole(h.fh, -1)
        await core.write(this.pathOf(fd), fd, frame.body, whole(h.offset, 0))
        return [{}, EMPTY]
      }
      case 'release': {
        const fd = whole(h.fh, -1)
        const held = this.pathOf(fd)
        try {
          await core.release(fd)
        } catch (err) {
          if (!this.told.has(fd)) this.lost.set(fd, [held, err])
          throw err
        }
        return [{}, EMPTY]
      }
      case 'mkdir':
        await core.mkdir(path, num(h.mode))
        return [{ a: wire(await core.getattr(path)), k: this.kept(path) }, EMPTY]
      case 'unlink':
        await core.unlink(path)
        return [{}, EMPTY]
      case 'rmdir':
        await core.rmdir(path)
        return [{}, EMPTY]
      case 'symlink':
        await core.symlink(typeof h.target === 'string' ? h.target : '', path)
        return [{ a: wire(await core.getattr(path)), k: this.kept(path) }, EMPTY]
      case 'rename': {
        const from = workspacePath(h.from)
        const to = workspacePath(h.to)
        if (h.noreplace === true && (await this.exists(to))) throw eexist(to)
        await core.rename(from, to)
        return [{}, EMPTY]
      }
      case 'setattr': {
        const size = num(h.size)
        if (size !== null) await core.truncate(path, size)
        const atime = num(h.atime)
        const mtime = num(h.mtime)
        const fields = [num(h.mode), num(h.uid), num(h.gid), atime, mtime]
        if (fields.some((field) => field !== null)) {
          await core.setattr(
            path,
            num(h.mode),
            num(h.uid),
            num(h.gid),
            atime === null ? null : new Date(atime),
            mtime === null ? null : new Date(mtime),
          )
        }
        return [{ a: wire(await core.getattr(path)), k: this.kept(path) }, EMPTY]
      }
      case 'statfs': {
        const s = core.statfs()
        return [
          {
            blocks: s.blocks,
            bfree: s.bfree,
            bavail: s.bavail,
            files: s.files,
            ffree: s.ffree,
            bsize: s.bsize,
            namelen: s.namemax,
            frsize: s.frsize,
          },
          EMPTY,
        ]
      }
      case 'getxattr':
        return [{}, await core.getxattr(path, String(h.name))]
      case 'setxattr': {
        const flags = whole(h.flags, 0)
        await core.setxattr(path, String(h.name), frame.body, {
          create: (flags & 1) !== 0,
          replace: (flags & 2) !== 0,
        })
        return [{}, EMPTY]
      }
      case 'listxattr':
        return [{ names: await core.listxattr(path) }, EMPTY]
      case 'removexattr':
        await core.removexattr(path, String(h.name))
        return [{}, EMPTY]
      default:
        throw new Error(`fsproto: no such request ${String(h.op)}`)
    }
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await this.core.getattr(path)
      return true
    } catch (err) {
      if ((classify(err) ?? messageCondition(err)) === 'ENOENT') return false
      throw err
    }
  }

  private async exit(): Promise<void> {
    let failed: { err: unknown } | null = null
    for (const [fd] of [...this.core.handles.items()]) {
      try {
        await this.run(() => this.core.release(fd))
      } catch (err) {
        failed ??= { err }
      }
    }
    this.writer?.end()
    if (failed !== null) throw failed.err
  }
}

registerPipeServer(
  'mirage',
  (files, session, run, served) => new FsprotoServer(files, session, run, served),
)
