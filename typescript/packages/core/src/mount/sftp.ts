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
import { eexist, enoent, enotdir } from '../errors/fs.ts'
import { registerPipeServer } from '../machine/mounts.ts'
import { PolicyDenied } from '../policy/errors.ts'
import type { PipeWriter } from '../runtime/types.ts'
import { loadOptionalPeer } from '../utils/optional_peer.ts'
import { posixNormpath } from '../utils/path.ts'
import { S_IFDIR, S_IFLNK, S_IFMT } from '../utils/stat_view.ts'
import type { Files } from '../workspace/files.ts'
import type { SessionState } from '../workspace/session/session.ts'
import { OPEN, PIPE_PACKET_SIZE, STATUS } from './constants.ts'
import { MountCore } from './core.ts'
import { messageCondition, SFTPStatusError } from './errors.ts'
import type { MountAttrs } from './types.ts'

/** An entry's SFTP attributes, as ssh2 reads and writes them. */
export interface Attributes {
  mode: number
  uid: number
  gid: number
  size: number
  atime: number
  mtime: number
}

interface FileEntry {
  filename: string
  longname: string
  attrs: Attributes
}

// The Buffer ssh2 takes, which core cannot name: only `buffer` makes one.
type Ssh2Buffer = never

/** What the server drives of an ssh2 SFTP channel; ssh2's own types need Node's. */
export interface SftpChannel {
  on(event: string, listener: (...args: never[]) => void): unknown
  status(id: number, code: number, message?: string): unknown
  name(id: number, names: FileEntry[]): unknown
  attrs(id: number, attrs: Attributes): unknown
  handle(id: number, handle: Ssh2Buffer): unknown
  data(id: number, data: Ssh2Buffer): unknown
  end(): unknown
}

// ssh2 answers only with a Buffer, which every host that loads ssh2 has.
function buffer(bytes: Uint8Array): Ssh2Buffer {
  const { Buffer } = globalThis as unknown as {
    Buffer: { from(data: ArrayBufferLike, offset: number, length: number): Ssh2Buffer }
  }
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function handleKey(handle: Uint8Array): string {
  return String.fromCharCode(...handle)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const NO_ATTRS = {} as Attributes

interface OpenFile {
  kind: 'file'
  path: string
  fd: number
}

type OpenHandle =
  | OpenFile
  | {
      kind: 'dir'
      path: string
      done: boolean
    }

/** SFTP attributes from a MountCore attr record. */
export function toAttrs(a: MountAttrs): Attributes {
  return {
    mode: a.mode,
    uid: a.uid,
    gid: a.gid,
    size: a.size,
    atime: Math.floor(a.atime.getTime() / 1000),
    mtime: Math.floor(a.mtime.getTime() / 1000),
  }
}

/** The `ls -l` line an SFTP v3 client prints for an entry. */
export function longname(name: string, a: Attributes): string {
  let permissions = (a.mode & S_IFMT) === S_IFDIR ? 'd' : (a.mode & S_IFMT) === S_IFLNK ? 'l' : '-'
  for (let shift = 6; shift >= 0; shift -= 3) {
    const triplet = (a.mode >> shift) & 0o7
    permissions += (triplet & 4 ? 'r' : '-') + (triplet & 2 ? 'w' : '-') + (triplet & 1 ? 'x' : '-')
  }
  const when = new Date(a.mtime * 1000)
  const day = String(when.getDate()).padStart(2)
  const time = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`
  const month = MONTHS[when.getMonth()] ?? ''
  return `${permissions}    1 ${String(a.uid).padEnd(8)} ${String(a.gid).padEnd(8)} ${String(a.size).padStart(8)} ${month} ${day} ${time} ${name}`
}

/** A client path as a workspace path: absolute, normalized, never above `/`. */
export function workspacePath(path: string): string {
  return posixNormpath('/' + path)
}

async function exists(core: MountCore, path: string): Promise<boolean> {
  try {
    await core.getattr(path)
    return true
  } catch (err) {
    if ((classify(err) ?? messageCondition(err)) === 'ENOENT') return false
    throw err
  }
}

/** The permissions an SFTP request carries, or null when it sent none. */
function modeOf(attrs: Partial<Attributes>): number | null {
  return typeof attrs.mode === 'number' ? attrs.mode : null
}

/**
 * Apply an SFTP setstat: a size truncates, and permissions, owner and times
 * are stored as chmod, chown and utimens through a kernel mount store them.
 * One with nothing to change still needs the path. SETSTAT and FSETSTAT
 * follow a link, as chmod(2) and fchmod(2) do. Mirrors Python's `set_attrs`.
 */
async function setAttrs(core: MountCore, path: string, attrs: Partial<Attributes>): Promise<void> {
  if (typeof attrs.size === 'number') await core.truncate(path, attrs.size)
  const fields = [
    modeOf(attrs),
    attrs.uid ?? null,
    attrs.gid ?? null,
    typeof attrs.atime === 'number' ? new Date(attrs.atime * 1000) : null,
    typeof attrs.mtime === 'number' ? new Date(attrs.mtime * 1000) : null,
  ] as const
  if (fields.some((field) => field !== null)) await core.setattr(path, ...fields, true)
  else if (typeof attrs.size !== 'number') await core.getattr(path, true)
}

/**
 * The SFTP status and message for a failure, by the condition core names,
 * its message the last resort. SFTP hands back only the status, so a
 * policy's reason for a refusal goes to the operator log, and so does an
 * error with neither a condition nor a code.
 */
function statusOf(err: unknown): [number, string] {
  if (err instanceof SFTPStatusError) return [err.status, err.message]
  if (err instanceof PolicyDenied && err.decision !== null) {
    console.info(`policy ${err.decision.policy} refused ${err.virtualPath}: ${err.decision.reason}`)
  }
  const condition = classify(err) ?? messageCondition(err)
  const message = err instanceof Error ? err.message : String(err)
  if (condition === 'ENOENT') return [STATUS.NO_SUCH_FILE, message]
  if (condition === 'EACCES' || condition === 'EROFS' || condition === 'EPERM') {
    return [STATUS.PERMISSION_DENIED, message]
  }
  if (condition === null && (err as { code?: unknown } | null)?.code === undefined) {
    console.warn(`unclassified mount error: ${String(err)}`)
  }
  return [STATUS.FAILURE, message]
}

/**
 * SFTP onto a workspace, through the MountCore FUSE uses.
 *
 * Every request lands on the one MountCore `makeCore` makes, bound to a
 * session, so SFTP sees exactly the tree, modes and policies a shell in
 * that session sees. Requests are answered one at a time in arrival
 * order: a client pipelines writes and then closes, and the close must
 * not overtake the writes it settles. ssh2 refuses any request type left
 * unhandled, so nothing here can fall through to the host filesystem.
 */
export class MirageSFTPServer {
  private readonly handles = new Map<string, OpenHandle>()
  private nextHandle = 0
  private core: MountCore | null = null
  private queue: Promise<void> = Promise.resolve()

  /**
   * @param sftp the SFTP channel.
   * @param makeCore makes the core on the first request.
   * @param onExit what the client's exit ends, after its handles are
   *   released.
   * @param passiveSshfs decode sshfs's reversed symlink arguments on a
   *   pipe without SSH peer identification.
   * @param run runs one request, with a line's write admission for a
   *   sandbox's pipe; by default it just runs it.
   * @param onLost told the handle, path and error of a release whose
   *   writes failed to land, before the client gets the status.
   */
  constructor(
    private readonly sftp: SftpChannel,
    private readonly makeCore: () => Promise<MountCore>,
    private readonly onExit?: () => Promise<void>,
    private readonly passiveSshfs = false,
    private readonly run: (op: () => Promise<void>) => Promise<void> = (op) => op(),
    private readonly onLost?: (fd: number, path: string, err: unknown) => void,
  ) {}

  /** Answer the client's requests; settles once it has left and its handles are released. */
  attach(): Promise<void> {
    const s = this.sftp
    s.on('REALPATH', (id: number, path: string) => {
      this.serve(id, () => this.realpath(id, path))
    })
    s.on('STAT', (id: number, path: string) => {
      this.serve(id, () => this.stat(id, path, true))
    })
    s.on('LSTAT', (id: number, path: string) => {
      this.serve(id, () => this.stat(id, path, false))
    })
    s.on('FSTAT', (id: number, handle: Uint8Array) => {
      this.serve(id, () => this.fstat(id, handle))
    })
    s.on('SETSTAT', (id: number, path: string, attrs: Partial<Attributes>) => {
      this.serve(id, () => this.simple(id, (core) => setAttrs(core, workspacePath(path), attrs)))
    })
    s.on('FSETSTAT', (id: number, handle: Uint8Array, attrs: Partial<Attributes>) => {
      this.serve(id, () => {
        const f = this.file(handle)
        // Its name now belongs to another file, or to none.
        if (this.core?.handles.get(f.fd)?.detached !== undefined) throw enoent(f.path)
        return this.simple(id, (core) => setAttrs(core, f.path, attrs))
      })
    })
    s.on('OPENDIR', (id: number, path: string) => {
      this.serve(id, () => this.opendir(id, path))
    })
    s.on('READDIR', (id: number, handle: Uint8Array) => {
      this.serve(id, () => this.readdir(id, handle))
    })
    s.on('OPEN', (id: number, filename: string, flags: number, attrs: Partial<Attributes>) => {
      this.serve(id, () => this.open(id, filename, flags, attrs))
    })
    s.on('READ', (id: number, handle: Uint8Array, offset: number, len: number) => {
      this.serve(id, () => this.read(id, handle, offset, len))
    })
    s.on('WRITE', (id: number, handle: Uint8Array, offset: number, data: Uint8Array) => {
      this.serve(id, () => this.write(id, handle, offset, data))
    })
    s.on('CLOSE', (id: number, handle: Uint8Array) => {
      this.serve(id, () => this.close(id, handle))
    })
    s.on('REMOVE', (id: number, path: string) => {
      this.serve(id, () => this.simple(id, (core) => core.unlink(workspacePath(path))))
    })
    s.on('MKDIR', (id: number, path: string, attrs: Partial<Attributes>) => {
      this.serve(id, () =>
        this.simple(id, (core) => core.mkdir(workspacePath(path), modeOf(attrs))),
      )
    })
    s.on('RMDIR', (id: number, path: string) => {
      this.serve(id, () => this.simple(id, (core) => core.rmdir(workspacePath(path))))
    })
    s.on('RENAME', (id: number, oldPath: string, newPath: string) => {
      this.serve(id, () => this.rename(id, workspacePath(oldPath), workspacePath(newPath)))
    })
    s.on('READLINK', (id: number, path: string) => {
      this.serve(id, () => this.readlink(id, path))
    })
    // SSH channels let ssh2 normalize OpenSSH's swap. Passive sshfs pipes
    // have no peer identification, so normalize their wire order here.
    // @types/ssh2 names the emitted parameters the other way round.
    s.on('SYMLINK', (id: number, linkPath: string, targetPath: string) => {
      if (this.passiveSshfs) [linkPath, targetPath] = [targetPath, linkPath]
      this.serve(id, () =>
        this.simple(id, (core) => core.symlink(targetPath, workspacePath(linkPath))),
      )
    })
    s.on('EXTENDED', (id: number) => {
      this.sftp.status(id, STATUS.OP_UNSUPPORTED, 'extension not supported')
    })
    return new Promise((resolve, reject) => {
      s.on('end', () => {
        this.queue = this.queue.then(() => this.exit())
        this.queue.then(resolve, reject)
      })
    })
  }

  private serve(id: number, task: () => Promise<void>): void {
    this.queue = this.queue.then(async () => {
      try {
        await this.run(task)
      } catch (err) {
        const [status, message] = statusOf(err)
        this.sftp.status(id, status, message)
      }
    })
  }

  private async mount(): Promise<MountCore> {
    this.core ??= await this.makeCore()
    return this.core
  }

  private addHandle(handle: OpenHandle): Ssh2Buffer {
    const id = new Uint8Array(4)
    new DataView(id.buffer).setUint32(0, this.nextHandle)
    this.nextHandle = (this.nextHandle + 1) >>> 0
    this.handles.set(handleKey(id), handle)
    return buffer(id)
  }

  private handle(buf: Uint8Array): OpenHandle {
    const handle = this.handles.get(handleKey(buf))
    if (handle === undefined) throw new SFTPStatusError(STATUS.FAILURE, 'invalid handle')
    return handle
  }

  private file(buf: Uint8Array): OpenFile {
    const handle = this.handle(buf)
    if (handle.kind !== 'file') throw new SFTPStatusError(STATUS.FAILURE, 'not a file handle')
    const ctx = this.core?.handles.get(handle.fd)
    if (ctx === undefined) throw new SFTPStatusError(STATUS.FAILURE, 'invalid handle')
    handle.path = ctx.path
    return handle
  }

  private async simple(id: number, op: (core: MountCore) => Promise<void>): Promise<void> {
    await op(await this.mount())
    this.sftp.status(id, STATUS.OK)
  }

  private async realpath(id: number, path: string): Promise<void> {
    await this.mount()
    const p = workspacePath(path)
    this.sftp.name(id, [{ filename: p, longname: p, attrs: NO_ATTRS }])
  }

  private async stat(id: number, path: string, follow: boolean): Promise<void> {
    const core = await this.mount()
    const p = workspacePath(path)
    this.sftp.attrs(id, toAttrs(await core.getattr(p, follow)))
  }

  private async fstat(id: number, buf: Uint8Array): Promise<void> {
    const core = await this.mount()
    const f = this.file(buf)
    this.sftp.attrs(id, toAttrs(await core.fgetattr(f.path, f.fd)))
  }

  private async opendir(id: number, path: string): Promise<void> {
    const core = await this.mount()
    const p = workspacePath(path)
    if (((await core.getattr(p)).mode & S_IFMT) !== S_IFDIR) throw enotdir(p)
    this.sftp.handle(id, this.addHandle({ kind: 'dir', path: p, done: false }))
  }

  private async readdir(id: number, buf: Uint8Array): Promise<void> {
    const core = await this.mount()
    const dir = this.handle(buf)
    if (dir.kind !== 'dir') throw new SFTPStatusError(STATUS.FAILURE, 'not a directory handle')
    if (dir.done) {
      this.sftp.status(id, STATUS.EOF)
      return
    }
    dir.done = true
    const entries: FileEntry[] = []
    for (const [name, attr] of await core.listing(dir.path)) {
      const attrs = toAttrs(attr)
      entries.push({ filename: name, longname: longname(name, attrs), attrs })
    }
    this.sftp.name(id, entries)
  }

  private async open(
    id: number,
    filename: string,
    flags: number,
    attrs: Partial<Attributes>,
  ): Promise<void> {
    const core = await this.mount()
    const path = workspacePath(filename)
    // The open's effect is the core's (create, exclusive, truncate), and a
    // directory refuses it, as SFTP opens files only.
    const creates = (flags & OPEN.CREAT) !== 0
    const mode = {
      readable: (flags & OPEN.READ) !== 0,
      writable: (flags & (OPEN.WRITE | OPEN.APPEND)) !== 0,
      truncate: (flags & OPEN.TRUNC) !== 0,
      append: (flags & OPEN.APPEND) !== 0,
      create: creates,
      exclusive: creates && (flags & OPEN.EXCL) !== 0,
      binary: true,
    }
    const fd = await core.open(path, mode, modeOf(attrs))
    this.sftp.handle(id, this.addHandle({ kind: 'file', path, fd }))
  }

  private async read(id: number, buf: Uint8Array, offset: number, len: number): Promise<void> {
    const core = await this.mount()
    const f = this.file(buf)
    const data = await core.read(f.path, f.fd, offset, len)
    if (data.byteLength === 0) {
      this.sftp.status(id, STATUS.EOF)
      return
    }
    this.sftp.data(id, buffer(data))
  }

  private async write(
    id: number,
    buf: Uint8Array,
    offset: number,
    data: Uint8Array,
  ): Promise<void> {
    const core = await this.mount()
    const f = this.file(buf)
    // A copy: the handle holds the bytes until close, and ssh2 reuses the
    // packet buffer they arrived in.
    await core.write(f.path, f.fd, new Uint8Array(data), offset)
    this.sftp.status(id, STATUS.OK)
  }

  private async close(id: number, buf: Uint8Array): Promise<void> {
    const core = await this.mount()
    const handle = this.handle(buf)
    this.handles.delete(handleKey(buf))
    if (handle.kind === 'file') await this.release(core, handle)
    this.sftp.status(id, STATUS.OK)
  }

  /** Release a file handle, telling `onLost` when its writes did not land. */
  private async release(core: MountCore, handle: OpenFile): Promise<void> {
    const path = core.handles.get(handle.fd)?.path ?? handle.path
    try {
      await core.release(handle.fd)
    } catch (err) {
      this.onLost?.(handle.fd, path, err)
      throw err
    }
  }

  // SFTP v3's rename refuses to replace an existing target.
  private async rename(id: number, oldPath: string, newPath: string): Promise<void> {
    const core = await this.mount()
    if (await exists(core, newPath)) throw eexist(newPath)
    await core.rename(oldPath, newPath)
    this.sftp.status(id, STATUS.OK)
  }

  private async readlink(id: number, path: string): Promise<void> {
    const core = await this.mount()
    const target = await core.readlink(workspacePath(path))
    this.sftp.name(id, [{ filename: target, longname: target, attrs: NO_ATTRS }])
  }

  private async exit(): Promise<void> {
    const core = this.core
    try {
      // Every handle is released past one that fails; the first failure is rethrown after onExit.
      let failed: { err: unknown } | null = null
      if (core !== null) {
        for (const handle of this.handles.values()) {
          if (handle.kind !== 'file') continue
          try {
            await this.run(() => this.release(core, handle))
          } catch (err) {
            failed ??= { err }
          }
        }
      }
      this.handles.clear()
      await this.onExit?.()
      if (failed !== null) throw failed.err
    } finally {
      this.sftp.end()
    }
  }
}

// What PipeServer takes of ssh2's internals: its SFTP class, run with a
// connection of our own whose only calls are a send and a close.
type Ssh2Sftp = new (
  client: { _protocol: object },
  chanInfo: object,
  cfg: { server: boolean },
) => SftpChannel & { push(data: Uint8Array | null): void }

/**
 * SFTP on a byte pipe as `session`, for a sandbox's sshfs.
 *
 * The client is `sshfs -o passive`, using OpenSSH's reversed symlink
 * wire order. Every request it makes is a request of `session`,
 * held to its hides, modes and policies. `run` runs each request (with a
 * line's write admission, for a sandbox).
 */
export class PipeServer {
  private readonly core: MountCore
  // Each released handle whose writes failed to land, until a sync.
  private lost = new Map<number, [string, unknown]>()
  // Handles whose failure a sync handed back, never handed back again.
  private readonly told = new Set<number>()

  /**
   * @param owner who owns what the mount shows when a row names its owner
   *   by name; the core's default when not given.
   */
  constructor(
    files: Files,
    session: SessionState,
    private readonly run: (op: () => Promise<void>) => Promise<void> = (op) => op(),
    owner?: { uid: number; gid: number },
  ) {
    this.core = new MountCore(files, { session, ...(owner === undefined ? {} : { owner }) })
  }

  /** Answer the client's requests until it closes the pipe. */
  async serve(reader: ReadableStream<Uint8Array>, writer: PipeWriter): Promise<void> {
    // A literal specifier, so a bundler carries ssh2 along; loaded only here, as an optional peer.
    const { SFTP } = (await loadOptionalPeer(() => import('ssh2/lib/protocol/SFTP.js'), {
      feature: 'serving the workspace into a machine',
      packageName: 'ssh2',
    })) as { SFTP: Ssh2Sftp }
    const side = () => ({ id: 0, window: Infinity, packetSize: PIPE_PACKET_SIZE, state: 'open' })
    const protocol = {
      _remoteIdentRaw: undefined,
      channelData: (_id: number, data: Uint8Array) => {
        writer.write(data)
      },
      channelClose: () => {
        writer.end()
      },
    }
    const sftp = new SFTP(
      { _protocol: protocol },
      { type: 'session', incoming: side(), outgoing: side() },
      { server: true },
    )
    const served = new MirageSFTPServer(
      sftp,
      () => Promise.resolve(this.core),
      undefined,
      true,
      this.run,
      (fd, path, err) => {
        this.lose(fd, path, err)
      },
    ).attach()
    const chunks = reader.getReader()
    try {
      for (;;) {
        const { done, value } = await chunks.read()
        if (done) break
        sftp.push(value)
      }
    } finally {
      sftp.push(null)
      await served
    }
  }

  /** Keep a release's failure for the next sync, unless a sync already reported its handle. */
  private lose(fd: number, path: string, err: unknown): void {
    if (!this.told.has(fd)) this.lost.set(fd, [path, err])
  }

  /**
   * Land every write the client has been told is done.
   *
   * shortcut: a handle reports its first failure only, and lines running at
   * once in one sandbox share the failures; key them by line if a sandbox
   * runs concurrent lines that write.
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
      // Keyed by handle: a close that raced this sync counts once.
      lost.set(fd, [path, err])
    }
    return [...lost.values()]
  }
}

registerPipeServer((files, session, run) => new PipeServer(files, session, run))
