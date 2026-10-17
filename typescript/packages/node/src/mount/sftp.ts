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

import { constants as fsConstants } from 'node:fs'
import { createRequire } from 'node:module'
import { constants as osConstants } from 'node:os'
import { posix } from 'node:path'
import type { SessionState } from '@struktoai/mirage-core/workspace/session/session'
import {
  currentCaller,
  runWithCaller,
  type Caller,
} from '@struktoai/mirage-core/context/session_context'
import { eexist, eisdir, enoent, enotdir } from '@struktoai/mirage-core/errors/fs'
import { registerPipeServer } from '@struktoai/mirage-core/runtime/sandbox/mounts'
import type { PipeWriter } from '@struktoai/mirage-core/runtime/types'
import type { Files } from '@struktoai/mirage-core/workspace/files'
import type { Attributes, FileEntry, SFTPWrapper } from 'ssh2'
import { OPEN, PIPE_PACKET_SIZE, SSH2_SFTP_MODULE, STATUS } from './constants.ts'
import { MountCore } from './core.ts'
import { EACCES, ENOENT, EROFS, SFTPStatusError, classifyErrno } from './errors.ts'
import type { MountAttrs } from './types.ts'

const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const NO_ATTRS = {} as Attributes

interface OpenFile {
  kind: 'file'
  path: string
  fd: number
  appendAt: number | null
}

interface OpenDir {
  kind: 'dir'
  path: string
  done: boolean
}

type OpenHandle = OpenFile | OpenDir

function isDir(mode: number): boolean {
  return (mode & S_IFMT) === S_IFDIR
}

function seconds(date: Date): number {
  return Math.floor(date.getTime() / 1000)
}

/** SFTP attributes from a MountCore attr record. */
export function toAttrs(a: MountAttrs): Attributes {
  return {
    mode: a.mode,
    uid: a.uid,
    gid: a.gid,
    size: a.size,
    atime: seconds(a.atime),
    mtime: seconds(a.mtime),
  }
}

function permissions(mode: number): string {
  const kind = isDir(mode) ? 'd' : (mode & S_IFMT) === S_IFLNK ? 'l' : '-'
  let bits = ''
  for (let shift = 6; shift >= 0; shift -= 3) {
    const triplet = (mode >> shift) & 0o7
    bits += (triplet & 4 ? 'r' : '-') + (triplet & 2 ? 'w' : '-') + (triplet & 1 ? 'x' : '-')
  }
  return kind + bits
}

/** The `ls -l` line an SFTP v3 client prints for an entry. */
export function longname(name: string, a: Attributes): string {
  const when = new Date(a.mtime * 1000)
  const day = String(when.getDate()).padStart(2)
  const time = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`
  const month = MONTHS[when.getMonth()] ?? ''
  return `${permissions(a.mode)}    1 ${String(a.uid).padEnd(8)} ${String(a.gid).padEnd(8)} ${String(a.size).padStart(8)} ${month} ${day} ${time} ${name}`
}

/** A client path as a workspace path: absolute, normalized, never above `/`. */
export function workspacePath(path: string): string {
  const normal = posix.normalize('/' + path.replace(/^\/+/, ''))
  return normal.length > 1 && normal.endsWith('/') ? normal.slice(0, -1) : normal
}

async function exists(core: MountCore, path: string): Promise<boolean> {
  try {
    await core.getattr(path)
    return true
  } catch (err) {
    if (classifyErrno(err) === ENOENT) return false
    throw err
  }
}

/** The permissions an SFTP request carries, or null when it sent none. */
function modeOf(attrs: Partial<Attributes>): number | null {
  return typeof attrs.mode === 'number' ? attrs.mode : null
}

const DENIED = new Set([EACCES, EROFS, osConstants.errno.EPERM])

/** The SFTP status and message for a failure, through the shared errno table. */
function statusOf(err: unknown): [number, string] {
  if (err instanceof SFTPStatusError) return [err.status, err.message]
  const code = classifyErrno(err)
  const message = err instanceof Error ? err.message : String(err)
  if (code === ENOENT) return [STATUS.NO_SUCH_FILE, message]
  if (DENIED.has(code)) return [STATUS.PERMISSION_DENIED, message]
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
   */
  constructor(
    private readonly sftp: SFTPWrapper,
    private readonly makeCore: () => Promise<MountCore>,
    private readonly onExit?: () => Promise<void>,
    private readonly passiveSshfs = false,
    private readonly run: (op: () => Promise<void>) => Promise<void> = (op) => op(),
  ) {}

  /** Answer the client's requests; settles once it has left and its handles are released. */
  attach(): Promise<void> {
    const s = this.sftp
    s.on('REALPATH', (id, path) => {
      this.serve(id, () => this.realpath(id, path))
    })
    s.on('STAT', (id, path) => {
      this.serve(id, () => this.stat(id, path, true))
    })
    s.on('LSTAT', (id, path) => {
      this.serve(id, () => this.stat(id, path, false))
    })
    s.on('FSTAT', (id, handle) => {
      this.serve(id, () => this.fstat(id, handle))
    })
    s.on('SETSTAT', (id, path, attrs) => {
      this.serve(id, () => this.setAttrs(id, workspacePath(path), attrs))
    })
    s.on('FSETSTAT', (id, handle, attrs) => {
      this.serve(id, () => {
        const f = this.file(handle)
        // Its name now belongs to another file, or to none.
        if (this.core?.handles.get(f.fd)?.detached !== undefined) throw enoent(f.path)
        return this.setAttrs(id, f.path, attrs)
      })
    })
    s.on('OPENDIR', (id, path) => {
      this.serve(id, () => this.opendir(id, path))
    })
    s.on('READDIR', (id, handle) => {
      this.serve(id, () => this.readdir(id, handle))
    })
    s.on('OPEN', (id, filename, flags, attrs) => {
      this.serve(id, () => this.open(id, filename, flags, attrs))
    })
    s.on('READ', (id, handle, offset, len) => {
      this.serve(id, () => this.read(id, handle, offset, len))
    })
    s.on('WRITE', (id, handle, offset, data) => {
      this.serve(id, () => this.write(id, handle, offset, data))
    })
    s.on('CLOSE', (id, handle) => {
      this.serve(id, () => this.close(id, handle))
    })
    s.on('REMOVE', (id, path) => {
      this.serve(id, () => this.simple(id, (core) => core.unlink(workspacePath(path))))
    })
    s.on('MKDIR', (id, path, attrs) => {
      this.serve(id, () =>
        this.simple(id, (core) => core.mkdir(workspacePath(path), modeOf(attrs))),
      )
    })
    s.on('RMDIR', (id, path) => {
      this.serve(id, () => this.simple(id, (core) => core.rmdir(workspacePath(path))))
    })
    s.on('RENAME', (id, oldPath, newPath) => {
      this.serve(id, () => this.rename(id, workspacePath(oldPath), workspacePath(newPath)))
    })
    s.on('READLINK', (id, path) => {
      this.serve(id, () => this.readlink(id, path))
    })
    // SSH channels let ssh2 normalize OpenSSH's swap. Passive sshfs pipes
    // have no peer identification, so normalize their wire order here.
    // @types/ssh2 names the emitted parameters the other way round.
    s.on('SYMLINK', (id, linkPath, targetPath) => {
      if (this.passiveSshfs) [linkPath, targetPath] = [targetPath, linkPath]
      this.serve(id, () =>
        this.simple(id, (core) => core.symlink(targetPath, workspacePath(linkPath))),
      )
    })
    s.on('EXTENDED', (id) => {
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

  private addHandle(handle: OpenHandle): Buffer {
    const id = Buffer.alloc(4)
    id.writeUInt32BE(this.nextHandle)
    this.nextHandle = (this.nextHandle + 1) >>> 0
    this.handles.set(id.toString('hex'), handle)
    return id
  }

  private handle(buf: Buffer): OpenHandle {
    const handle = this.handles.get(buf.toString('hex'))
    if (handle === undefined) throw new SFTPStatusError(STATUS.FAILURE, 'invalid handle')
    return handle
  }

  private file(buf: Buffer): OpenFile {
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

  private async fstat(id: number, buf: Buffer): Promise<void> {
    const core = await this.mount()
    const f = this.file(buf)
    this.sftp.attrs(id, toAttrs(await core.fgetattr(f.path, f.fd)))
  }

  // A size truncates, and permissions, owner and times are stored as
  // chmod, chown and utimens through a kernel mount store them. One with
  // nothing to change still needs the path. Mirrors Python's `set_attrs`.
  private async setAttrs(id: number, path: string, attrs: Partial<Attributes>): Promise<void> {
    const core = await this.mount()
    if (typeof attrs.size === 'number') await core.truncate(path, attrs.size)
    const fields = [
      modeOf(attrs),
      attrs.uid ?? null,
      attrs.gid ?? null,
      typeof attrs.atime === 'number' ? new Date(attrs.atime * 1000) : null,
      typeof attrs.mtime === 'number' ? new Date(attrs.mtime * 1000) : null,
    ] as const
    // SETSTAT and FSETSTAT follow a link, as chmod(2) and fchmod(2) do.
    if (fields.some((field) => field !== null)) await core.setattr(path, ...fields, true)
    else if (typeof attrs.size !== 'number') await core.getattr(path, true)
    this.sftp.status(id, STATUS.OK)
  }

  private async opendir(id: number, path: string): Promise<void> {
    const core = await this.mount()
    const p = workspacePath(path)
    if (!isDir((await core.getattr(p)).mode)) throw enotdir(p)
    this.sftp.handle(id, this.addHandle({ kind: 'dir', path: p, done: false }))
  }

  private async readdir(id: number, buf: Buffer): Promise<void> {
    const core = await this.mount()
    const dir = this.handle(buf)
    if (dir.kind !== 'dir') throw new SFTPStatusError(STATUS.FAILURE, 'not a directory handle')
    if (dir.done) {
      this.sftp.status(id, STATUS.EOF)
      return
    }
    dir.done = true
    const entries: FileEntry[] = []
    for (const name of await core.readdir(dir.path)) {
      const child =
        name === '.'
          ? dir.path
          : name === '..'
            ? posix.dirname(dir.path)
            : posix.join(dir.path, name)
      let attr: MountAttrs
      try {
        attr = await core.getattr(child)
      } catch (err) {
        // Vanished between the listing and its stat, as ls leaves out a
        // file deleted mid-listing; anything else is a real failure.
        if (classifyErrno(err) !== ENOENT) throw err
        continue
      }
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
    const found = await exists(core, path)
    if (found && (flags & OPEN.CREAT) !== 0 && (flags & OPEN.EXCL) !== 0) {
      throw eexist(path)
    }
    let fd: number
    if (!found) {
      if ((flags & OPEN.CREAT) === 0) throw enoent(path)
      fd = await core.create(path, modeOf(attrs))
    } else {
      if (isDir((await core.getattr(path)).mode)) throw eisdir(path)
      fd = await core.open(path, (flags & OPEN.TRUNC) !== 0 ? fsConstants.O_TRUNC : 0)
    }
    const appendAt = (flags & OPEN.APPEND) !== 0 ? (await core.fgetattr(path, fd)).size : null
    this.sftp.handle(id, this.addHandle({ kind: 'file', path, fd, appendAt }))
  }

  private async read(id: number, buf: Buffer, offset: number, len: number): Promise<void> {
    const core = await this.mount()
    const f = this.file(buf)
    const data = await core.read(f.path, f.fd, offset, len)
    if (data.byteLength === 0) {
      this.sftp.status(id, STATUS.EOF)
      return
    }
    this.sftp.data(id, Buffer.from(data.buffer, data.byteOffset, data.byteLength))
  }

  private async write(id: number, buf: Buffer, offset: number, data: Buffer): Promise<void> {
    const core = await this.mount()
    const f = this.file(buf)
    let at = offset
    if (f.appendAt !== null) {
      at = f.appendAt
      f.appendAt += data.byteLength
    }
    // A copy: the handle holds the bytes until close, and ssh2 reuses the
    // packet buffer they arrived in.
    await core.write(f.path, f.fd, new Uint8Array(data), at)
    this.sftp.status(id, STATUS.OK)
  }

  private async close(id: number, buf: Buffer): Promise<void> {
    const core = await this.mount()
    const handle = this.handle(buf)
    this.handles.delete(buf.toString('hex'))
    if (handle.kind === 'file') await core.release(handle.fd)
    this.sftp.status(id, STATUS.OK)
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
      if (core !== null) {
        for (const handle of this.handles.values()) {
          if (handle.kind === 'file') await core.release(handle.fd)
        }
      }
      this.handles.clear()
      await this.onExit?.()
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
) => SFTPWrapper & { push(data: Buffer | null): void }

function loadSftp(): Ssh2Sftp {
  try {
    const mod = createRequire(import.meta.url)(SSH2_SFTP_MODULE) as { SFTP: Ssh2Sftp }
    return mod.SFTP
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(
      `ssh2 is required to serve the workspace into a sandbox; install it as a peer dep: ${msg}`,
    )
  }
}

/**
 * SFTP on a byte pipe as `session`, for a sandbox's sshfs.
 *
 * The client is `sshfs -o passive`, using OpenSSH's reversed symlink
 * wire order. Every request it makes is a request of `session`,
 * held to its hides, modes and policies, and runs with the write
 * admission `admission` gives when it arrives.
 */
export class PipeServer {
  private readonly core: MountCore

  constructor(
    files: Files,
    session: SessionState,
    private readonly admission: () => Pick<Caller, 'stop' | 'writeHeld'>,
  ) {
    this.core = new MountCore(files, { session })
  }

  /** Answer the client's requests until it closes the pipe. */
  async serve(reader: ReadableStream<Uint8Array>, writer: PipeWriter): Promise<void> {
    const SFTP = loadSftp()
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
      (op) => runWithCaller({ ...currentCaller(), ...this.admission() }, op),
    ).attach()
    const chunks = reader.getReader()
    try {
      for (;;) {
        const { done, value } = await chunks.read()
        if (done) break
        sftp.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
      }
    } finally {
      sftp.push(null)
      await served
    }
  }

  /** Land every write the client has been told is done. */
  sync(): Promise<void> {
    return this.core.sync()
  }
}

registerPipeServer((files, session, admission) => new PipeServer(files, session, admission))
