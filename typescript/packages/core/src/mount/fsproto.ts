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
import { eacces, ebadf, eexist, efbig, enoent } from '../errors/fs.ts'
import { registerPipeServer } from '../machine/mounts.ts'
import { PolicyDenied } from '../policy/errors.ts'
import { READ, type OpenMode } from '../runtime/handles/index.ts'
import type { PipeWriter } from '../runtime/types.ts'
import { concat } from '../utils/bytes.ts'
import { CycleError, posixNormpath } from '../utils/path.ts'
import { S_IFDIR, S_IFMT } from '../utils/stat_view.ts'
import { readerOf, type Files } from '../workspace/files.ts'
import type { SessionState } from '../workspace/session/session.ts'
import {
  FSPROTO_FRAME_BYTES,
  FSPROTO_READ_CONCURRENCY,
  FSPROTO_READ_OPS,
  FSPROTO_VERSION,
  FSPROTO_WHOLE_BYTES,
} from './constants.ts'
import { MountCore } from './core.ts'
import { messageCondition } from './errors.ts'
import type { MountAttrs, ServedPrefix } from './types.ts'
import { rstripSlash } from '../utils/slash.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const EMPTY = new Uint8Array(0)
// How long a barrier waits for the machine's answer before the line is refused.
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

/**
 * A reply as a frame the client accepts: one past `limit` is refused as
 * `EFBIG`, so the pipe stays usable. Mirrors Python's `bounded`.
 */
export function bounded(
  head: Head,
  body: Uint8Array = EMPTY,
  limit: number = FSPROTO_FRAME_BYTES,
): Uint8Array {
  const frame = encodeFrame(head, body)
  if (frame.byteLength - 4 <= limit) return frame
  return encodeFrame({ id: head.id, errno: 'EFBIG' })
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
  const a = rstripSlash(path)
  const b = rstripSlash(prefix)
  return a === b || b.startsWith(`${a}/`) || a.startsWith(`${b}/`)
}

/** Whether `path` is `prefix` or inside it. */
function under(path: string, prefix: string): boolean {
  const base = rstripSlash(prefix)
  return base === '' || path === base || path.startsWith(`${base}/`)
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
 * session sees. Requests that only read (FSPROTO_READ_OPS, an open that
 * neither writes nor truncates) are answered together, up to
 * FSPROTO_READ_CONCURRENCY at once; any other request waits for every one
 * before it and holds back every one after it, so answers are the ones
 * arrival order gives and a release never overtakes the writes it settles.
 * A read-only handle's release waits only for its own handle's reads. Each
 * reply about a path says whether the client may keep it until told
 * otherwise (`k`): only for a backend nothing but the workspace changes
 * (`BaseVFS.soleWriter`), whose every change this server pushes to the client as
 * it is noted, and `begin` waits until the client has applied them all.
 * While a policy judges the session's file calls, no answer is kept, so
 * every call a program makes reaches it. Mirrors Python's `FsprotoServer`.
 */
export class FsprotoServer {
  private readonly core: MountCore
  private writer: PipeWriter | null = null
  private queue: Promise<void> = Promise.resolve()
  private slots = FSPROTO_READ_CONCURRENCY
  private readonly waitingSlot: (() => void)[] = []
  private barrier: Promise<void> | null = null
  private readonly reading = new Map<Promise<void>, number | null>()
  private readonly answering = new Set<Promise<void>>()
  private readonly readOnly = new Set<number>()
  private lost = new Map<number, [string, unknown]>()
  private readonly told = new Set<number>()
  private readonly acks = new Map<number, (confirmed: boolean) => void>()
  private readonly invalid = new Set<string>()
  private flushing = false
  private hid = 0
  private ended = false
  private keeping = false
  private readonly sessionId: string
  private readonly files: Files

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
    this.files = files.forSession(session.sessionId)
    this.sessionId = session.sessionId
  }

  /** Answer the client's requests until it closes the pipe. */
  async serve(reader: ReadableStream<Uint8Array>, writer: PipeWriter): Promise<void> {
    this.writer = writer
    const served = this.served
    const unwatch =
      served?.changes?.watch((path, by) => {
        if (by === served.machine || !overlaps(path, served.prefix)) return
        if (!this.core.visible(path)) return
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
      for (const ack of this.acks.values()) ack(false)
      this.acks.clear()
      this.queue = this.queue
        .catch((err: unknown) => {
          console.debug('fsproto: a request failed past its reply', err)
        })
        .then(() => Promise.allSettled([...this.answering]))
        .then(() => this.exit())
      await this.queue
    }
  }

  /**
   * Wait until the client has applied every change noted so far: the
   * barrier a line passes before its program starts. Once a policy judges
   * the session's file calls, the client first forgets all it kept and
   * refuses reads through opens its kernel may cache (`watch`), so each
   * call the program makes reaches that policy.
   *
   * @returns false when the client did not answer within
   *   BEGIN_WAIT_SECONDS or its pipe ended first, so the line must not run
   *   on what it still keeps.
   */
  async begin(): Promise<boolean> {
    if (this.ended || this.writer === null) return true
    const served = this.served
    if (served !== null && this.keeping && (await this.watching())) {
      this.keeping = false
      this.send({ push: 'watch' })
    }
    this.flush()
    this.hid += 1
    const hid = this.hid
    let timer: ReturnType<typeof setTimeout> | undefined
    const confirmed = await new Promise<boolean>((resolve) => {
      this.acks.set(hid, resolve)
      timer = setTimeout(() => {
        if (this.acks.delete(hid)) resolve(false)
      }, BEGIN_WAIT_SECONDS * 1000)
      this.send({ hid, op: 'begin' })
    })
    clearTimeout(timer)
    return confirmed
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
    this.write(encodeFrame(head, body))
  }

  private write(frame: Uint8Array): void {
    if (this.writer === null || this.ended) return
    this.writer.write(frame)
  }

  private flush(): void {
    if (this.invalid.size === 0) return
    const paths = [...this.invalid]
    this.invalid.clear()
    this.send({ push: 'inval', paths })
  }

  /**
   * Take a request in the order it came, and answer it once what it waits
   * for is answered: a request that only reads, once the last request that
   * changes something is; a read-only handle's release, once that and its
   * handle's reads are; any other request, once every request before it is.
   * A read holds one of FSPROTO_READ_CONCURRENCY slots while it is out, so
   * a client that asks ahead has no more than that many answered at once.
   * Mirrors Python's `_work`.
   */
  private take(frame: Frame): void {
    const hid = num(frame.head.hid)
    if (hid !== null) {
      this.acks.get(hid)?.(true)
      this.acks.delete(hid)
      return
    }
    const id = num(frame.head.id)
    if (id === null) return
    this.queue = this.queue.then(() => this.schedule(frame, id))
  }

  private async schedule(frame: Frame, id: number): Promise<void> {
    const after: Promise<void>[] = this.barrier === null ? [] : [this.barrier]
    const fd = num(frame.head.fh)
    if (this.reads(frame)) {
      await this.slot()
      this.reading.set(this.start(frame, id, after, true), fd)
    } else if (frame.head.op === 'release' && fd !== null && this.readOnly.has(fd)) {
      for (const [task, held] of this.reading) if (held === fd) after.push(task)
      this.reading.set(this.start(frame, id, after, false), fd)
    } else {
      after.push(...this.reading.keys())
      this.reading.clear()
      this.barrier = this.start(frame, id, after, false)
    }
  }

  /** Whether a request only reads: a FSPROTO_READ_OPS op, or an open that neither writes nor truncates. */
  private reads(frame: Frame): boolean {
    const h = frame.head
    if (h.op === 'open') return h.write !== true && h.truncate !== true
    return typeof h.op === 'string' && FSPROTO_READ_OPS.has(h.op)
  }

  /** Answer a request once the answers in `after` are given, giving back its read slot if it holds one. */
  private start(frame: Frame, id: number, after: Promise<void>[], slot: boolean): Promise<void> {
    const task = (async () => {
      try {
        await Promise.allSettled(after)
        await this.reply(frame, id)
      } finally {
        if (slot) this.freeSlot()
      }
    })()
    this.answering.add(task)
    const done = (): void => {
      this.answering.delete(task)
      this.reading.delete(task)
      if (this.barrier === task) this.barrier = null
    }
    task.then(done, done)
    return task
  }

  private async slot(): Promise<void> {
    if (this.slots > 0) {
      this.slots -= 1
      return
    }
    await new Promise<void>((resolve) => {
      this.waitingSlot.push(resolve)
    })
  }

  private freeSlot(): void {
    const next = this.waitingSlot.shift()
    if (next === undefined) this.slots += 1
    else next()
  }

  /**
   * Answer one request, the reply waiting for the pipe once the writer holds
   * more unsent than it lets wait: a client that asks ahead never has the
   * host hold every reply it asked for. Only the writer holds the reply's
   * bytes while it waits, so answers in flight together cost one copy each.
   * Mirrors Python's `_reply`.
   */
  private async reply(frame: Frame, id: number): Promise<void> {
    try {
      this.write(await this.framed(frame, id))
      if (this.writer !== null && !this.ended) await this.writer.drain()
    } catch (err) {
      console.debug(`fsproto: answering ${String(id)} failed`, err)
    }
  }

  /**
   * The reply to request `id` as a frame: its answer, or the errno it failed
   * with. Mirrors Python's `_framed`.
   */
  private async framed(frame: Frame, id: number): Promise<Uint8Array> {
    let answer: [Head, Uint8Array] = [{}, EMPTY]
    try {
      await this.run(async () => {
        answer = await this.answer(frame)
      })
      return bounded({ ...answer[0], id }, answer[1])
    } catch (err) {
      return encodeFrame({ id, errno: condition(err) })
    }
  }

  /** `path`, refused as EACCES when it is outside the prefix the client mounts. */
  private inside(path: string): string {
    if (this.served === null || under(path, this.served.prefix)) return path
    throw eacces(path)
  }

  /**
   * A listing on the wire: in a kept one, a folder another mount serves
   * carries that mount's own `k`. Mirrors Python's `_rows`.
   */
  private rows(folder: string, rows: [string, MountAttrs][], kept: boolean): unknown[] {
    return rows.map(([name, a]) => {
      const row = this.wired(child(folder, name), a)
      if (kept && (a.mode & S_IFMT) === S_IFDIR && !this.kept(child(folder, name))) row.k = false
      return [name, row]
    })
  }

  /**
   * The reply to `hello`: the protocol, that attributes carry `x`
   * (`wired`), and the read-ahead the served prefix sets. Mirrors Python's
   * `_hello`.
   */
  private hello(): Head {
    const head: Head = { proto: FSPROTO_VERSION, xattrs: true }
    const served = this.served
    if (served?.readAhead !== undefined && served.readAhead !== null)
      head.read_ahead = served.readAhead
    if (served?.readAheadTotal !== undefined && served.readAheadTotal !== null) {
      head.read_ahead_total = served.readAheadTotal
    }
    if (served?.readAheadAdapts !== undefined && served.readAheadAdapts !== null) {
      head.read_ahead_adapts = served.readAheadAdapts
    }
    return head
  }

  /**
   * A path's attributes as fsproto carries them, with `x` when a caller set
   * an extended attribute on it, as `getxattr` finds it: a client keeping
   * the attributes answers "none" for the rest itself. Mirrors Python's
   * `_wired`.
   */
  private wired(path: string, a: MountAttrs): Head {
    const row = wire(a)
    const reader = readerOf(this.files)
    let marked = true
    try {
      marked = reader.hasXattrs(reader.follow(this.core.resolve(path)))
    } catch (err) {
      if (!(err instanceof CycleError)) throw err
    }
    if (marked) row.x = true
    return row
  }

  /**
   * Whether the client may keep its answer about `path` until told
   * otherwise: only on a sole writer's mount (`BaseVFS.soleWriter`).
   * Mirrors Python's `_kept`.
   */
  private kept(path: string): boolean {
    return readerOf(this.files).owner(path)?.soleWriter === true
  }

  /**
   * The keep fields of a reply about `path`: `k`, and `w` while a policy
   * judges the session's file calls, when neither the client nor its
   * kernel may keep the answer even for a moment. The watch is read once,
   * and any other answer, kept or held for a second, marks the client as
   * holding one for the next `begin` to drop. Mirrors Python's `_keep`.
   */
  private async keep(path: string): Promise<{ k: boolean; w?: true }> {
    if (await this.watching()) return { k: false, w: true }
    this.keeping = true
    return { k: this.kept(path) }
  }

  private async watching(): Promise<boolean> {
    const watched = this.served?.watched
    if (watched === undefined || watched === null) return false
    return watched(this.sessionId)
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
    if ('path' in h) this.inside(path)
    switch (h.op) {
      case 'hello':
        return [this.hello(), EMPTY]
      case 'getattr': {
        const fd = num(h.fh)
        if (fd === null)
          return [
            { a: this.wired(path, await core.getattr(path)), ...(await this.keep(path)) },
            EMPTY,
          ]
        const held = this.pathOf(fd)
        return [
          { a: this.wired(held, await core.fgetattr(held, fd)), ...(await this.keep(held)) },
          EMPTY,
        ]
      }
      case 'list': {
        const keep = await this.keep(path)
        const rows = shown(await core.listing(path))
        return [{ e: this.rows(path, rows, keep.k), ...keep }, EMPTY]
      }
      case 'readall': {
        const [a, data] = await this.whole(path)
        return [{ a: this.wired(path, a), ...(await this.keep(path)) }, data]
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
        if (!mode.writable) this.readOnly.add(fd)
        const keep = await this.keep(path)
        const first = Math.min(whole(h.first, 0), FSPROTO_WHOLE_BYTES)
        if (first > 0 && !mode.writable && keep.w !== true) {
          // A read-only open's first bytes, read with it, so its first read
          // costs no trip of its own. A read that fails leaves the open as it
          // is, for that read to meet. They are at most what a whole read
          // carries, so the reply fits a frame and the client gets its handle.
          try {
            const data = await core.read(path, fd, 0, first)
            return [{ fh: fd, first: true, ...keep }, data]
          } catch (err) {
            console.debug(`fsproto: reading ${path} at open`, err)
          }
        }
        return [{ fh: fd, ...keep }, EMPTY]
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
        return [
          {
            fh: fd,
            a: this.wired(path, await core.fgetattr(path, fd)),
            ...(await this.keep(path)),
          },
          EMPTY,
        ]
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
      case 'flush': {
        const fd = whole(h.fh, -1)
        await core.flush(this.pathOf(fd), fd)
        return [{}, EMPTY]
      }
      case 'release': {
        const fd = whole(h.fh, -1)
        this.readOnly.delete(fd)
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
        return [
          { a: this.wired(path, await core.getattr(path)), ...(await this.keep(path)) },
          EMPTY,
        ]
      case 'unlink':
        await core.unlink(path)
        return [{}, EMPTY]
      case 'rmdir':
        await core.rmdir(path)
        return [{}, EMPTY]
      case 'symlink':
        await core.symlink(typeof h.target === 'string' ? h.target : '', path)
        return [
          { a: this.wired(path, await core.getattr(path)), ...(await this.keep(path)) },
          EMPTY,
        ]
      case 'rename': {
        const from = this.inside(workspacePath(h.from))
        const to = this.inside(workspacePath(h.to))
        if (h.noreplace === true && (await this.exists(to))) throw eexist(to)
        await core.rename(from, to)
        return [{}, EMPTY]
      }
      case 'setattr': {
        const fd = num(h.fh)
        const size = num(h.size)
        const atime = num(h.atime)
        const mtime = num(h.mtime)
        const rest = [num(h.mode), num(h.uid), num(h.gid), atime, mtime].some((v) => v !== null)
        const target = fd === null ? path : this.pathOf(fd)
        if (fd !== null) {
          if (rest && core.handles.get(fd)?.detached !== undefined) throw enoent(target)
          if (size !== null) await core.ftruncate(fd, size)
        } else if (size !== null) {
          await core.truncate(path, size)
        }
        if (rest) {
          await core.setattr(
            target,
            num(h.mode),
            num(h.uid),
            num(h.gid),
            atime === null ? null : new Date(atime),
            mtime === null ? null : new Date(mtime),
          )
        }
        const attrs = fd === null ? await core.getattr(path) : await core.fgetattr(target, fd)
        return [{ a: this.wired(target, attrs), ...(await this.keep(target)) }, EMPTY]
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
