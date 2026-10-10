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

import { Buffer } from 'node:buffer'
import { constants } from 'node:fs'
import { createRequire } from 'node:module'
import { posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classify } from '@struktoai/mirage-core/errors/classify'
import { ebadf, isMissingPath } from '@struktoai/mirage-core/errors/fs'
import { posixErrno, posixPhrase } from '@struktoai/mirage-core/errors/posix'
import type { FsCondition } from '@struktoai/mirage-core/errors/types'
import { workspaceBridge } from '@struktoai/mirage-core/runtime/binding'
import { RuntimeFiles } from '@struktoai/mirage-core/runtime/files'
import { posixStat } from '@struktoai/mirage-core/runtime/stat'
import { PrefixResolver } from '@struktoai/mirage-core/runtime/resolver'
import type { VFSEntry, VFSStat } from '@struktoai/mirage-core/runtime/types'
import { MountMode, type SetAttrFields } from '@struktoai/mirage-core/types'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import {
  DESCRIPTOR_CALLS,
  LISTENED_CALLS,
  PATH_ARGS,
  REFUSED_CALLS,
  ROUTED_CALLS,
  type RoutedCall,
} from './constants.ts'
import { Descriptors, openFlags, readAt, readOn } from './descriptors.ts'

type FsObject = Record<string, unknown>
type Fn = (...args: unknown[]) => unknown
type Callback = (err: unknown, value?: unknown) => void
type Options = Record<string, unknown> | string | number | null | undefined

const fs = createRequire(import.meta.url)('node:fs') as FsObject & { promises: FsObject }
const { S_IFMT, S_IFREG, S_IFDIR, S_IFCHR, S_IFLNK, W_OK, X_OK, COPYFILE_EXCL } = constants

/** `path` as a string a mount could serve, or null: a descriptor and a
 * Buffer are host spellings no mount uses. */
function spelled(path: unknown): string | null {
  if (typeof path === 'string') return path
  if (path instanceof URL && path.protocol === 'file:') return fileURLToPath(path)
  return null
}

/** A stamp in nanoseconds, as node's BigIntStats spells one. */
function ns(date: Date): bigint {
  return BigInt(date.getTime()) * 1_000_000n
}

/** A refusal spelled the way node's own fs spells an error. */
function refusal(condition: FsCondition, syscall: string, path: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(
    `${condition}: ${posixPhrase(condition)}, ${syscall} '${path}'`,
  )
  err.code = condition
  err.errno = -posixErrno(condition)
  err.syscall = syscall
  err.path = path
  return err
}

function syncRefusal(name: string, path: string): NodeJS.ErrnoException {
  const err = refusal('ENOTSUP', name, path)
  err.message = `mirage.patchNodeFs: sync fs methods not supported on a mounted path; use fs.promises.${name.replace(/Sync$/, '')} ('${path}')`
  return err
}

/** An options argument's fields; node takes null, a number (a mode)
 * and a string (an encoding) there too, which name none of them. */
function fieldsOf(options: Options): Record<string, unknown> {
  return typeof options === 'object' && options !== null ? options : {}
}

function encodingOf(options: Options): BufferEncoding | undefined {
  if (typeof options === 'string') return options as BufferEncoding
  return (fieldsOf(options).encoding ?? undefined) as BufferEncoding | undefined
}

function bytesOf(data: unknown, options: Options): Uint8Array {
  if (typeof data === 'string') return Buffer.from(data, encodingOf(options) ?? 'utf8')
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  throw new TypeError('mirage.patchNodeFs: data must be a string or an ArrayBufferView')
}

/** An async iterator whose first read throws `err`: the shape node's
 * `fs.promises.glob` and `watch` answer in, failures included. */
function refusedIterator(err: Error): AsyncIterableIterator<never> {
  return {
    next: () => Promise.reject(err),
    [Symbol.asyncIterator]() {
      return this
    },
  }
}

function leaf(entry: string): string {
  const trimmed = entry.endsWith('/') ? entry.slice(0, -1) : entry
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

/** A time argument (seconds, a numeric string, a Date) as the ISO stamp
 * setattr stores. */
function stampOf(time: unknown): string {
  const ms = time instanceof Date ? time.getTime() : Number(time) * 1000
  return new Date(ms).toISOString()
}

/** A read's buffer, where in it to put the bytes, how many to read and
 * from where, out of any of node's read spellings: `(buffer, offset,
 * length, position)`, `(buffer, options)`, `(options)` or nothing, then
 * the caller's own buffer object, which node hands back. A null position
 * reads at the descriptor's position and advances it. */
function readArgs(args: unknown[]): [Uint8Array, number, number, number | null, unknown] {
  const [first, ...rest] = args
  const view = ArrayBuffer.isView(first)
  const options = fieldsOf((view ? rest[0] : first) as Options)
  const given = view ? first : options.buffer
  const original = ArrayBuffer.isView(given) ? given : Buffer.alloc(16384)
  const buffer = new Uint8Array(original.buffer, original.byteOffset, original.byteLength)
  const positional = view && typeof rest[0] !== 'object'
  const offset = Number((positional ? rest[0] : options.offset) ?? 0)
  const length = Number((positional ? rest[1] : options.length) ?? buffer.byteLength - offset)
  const position = (positional ? rest[2] : options.position) as number | bigint | null | undefined
  return [buffer, offset, length, positionOf(position), original]
}

/** A write's bytes and where they go, out of node's write spellings:
 * `(buffer, offset, length, position)`, `(buffer, options)` and
 * `(string, position, encoding)`. */
function writeArgs(data: unknown, rest: unknown[]): [Uint8Array, number | null] {
  if (typeof data === 'string') {
    const encoding = (typeof rest[1] === 'string' ? rest[1] : 'utf8') as BufferEncoding
    return [Buffer.from(data, encoding), positionOf(rest[0] as number | null | undefined)]
  }
  const bytes = bytesOf(data, null)
  const options = typeof rest[0] === 'object' ? fieldsOf(rest[0] as Options) : null
  const offset = Number((options === null ? rest[0] : options.offset) ?? 0)
  const length = Number((options === null ? rest[1] : options.length) ?? bytes.byteLength - offset)
  const position = (options === null ? rest[2] : options.position) as number | null | undefined
  return [bytes.subarray(offset, offset + length), positionOf(position)]
}

// The routed calls that take a descriptor or a FileHandle in the path
// slot as well as a path.
const FILE_CALLS: ReadonlySet<string> = new Set(['appendFile', 'readFile', 'writeFile'])

/** Answer a node callback from a promise of what follows its error slot. */
function answer(work: Promise<unknown[]>, done: Fn): void {
  work.then(
    (values) => {
      done(null, ...values)
    },
    (err: unknown) => {
      done(err)
    },
  )
}

/** A position argument as an offset, or null for "at the position". */
function positionOf(position: number | bigint | null | undefined): number | null {
  if (position === null || position === undefined) return null
  const at = Number(position)
  return at < 0 ? null : at
}

/**
 * The `FileHandle` `fs.promises.open` answers a mounted path with: node's
 * own methods over a descriptor of the patch's, whose writes land at
 * `close` or `sync`.
 */
class MountedFileHandle {
  private closed = false

  constructor(
    private readonly host: HostFs,
    readonly fd: number,
  ) {}

  async read(...args: unknown[]): Promise<{ bytesRead: number; buffer: unknown }> {
    const [buffer, offset, length, position, original] = readArgs(args)
    const bytesRead = await this.host.fdRead(this.fd, buffer, offset, length, position)
    return { bytesRead, buffer: original }
  }

  async readFile(options?: Options): Promise<Buffer | string> {
    const bytes = Buffer.from(await this.host.fdReadAll(this.fd))
    const encoding = encodingOf(options)
    return encoding === undefined ? bytes : bytes.toString(encoding)
  }

  async readv(
    buffers: Uint8Array[],
    position?: number | null,
  ): Promise<{ bytesRead: number; buffers: Uint8Array[] }> {
    const [bytesRead] = await this.host.descriptorCall('readv', [this.fd, buffers, position])
    return { bytesRead: bytesRead as number, buffers }
  }

  async write(
    data: unknown,
    ...rest: unknown[]
  ): Promise<{ bytesWritten: number; buffer: unknown }> {
    const [bytes, position] = writeArgs(data, rest)
    return { bytesWritten: await this.host.fdWrite(this.fd, bytes, position), buffer: data }
  }

  async writev(
    buffers: Uint8Array[],
    position?: number | null,
  ): Promise<{ bytesWritten: number; buffers: Uint8Array[] }> {
    const [bytesWritten] = await this.host.descriptorCall('writev', [this.fd, buffers, position])
    return { bytesWritten: bytesWritten as number, buffers }
  }

  async writeFile(data: unknown, options?: Options): Promise<void> {
    await this.host.fdWrite(this.fd, bytesOf(data, options), null)
  }

  appendFile(data: unknown, options?: Options): Promise<void> {
    return this.writeFile(data, options)
  }

  stat(options?: Options): Promise<unknown> {
    return this.host.fdStat(this.fd, options)
  }

  truncate(len = 0): Promise<void> {
    return this.host.fdTruncate(this.fd, len)
  }

  sync(): Promise<void> {
    return this.host.fdSync(this.fd)
  }

  datasync(): Promise<void> {
    return this.host.fdSync(this.fd)
  }

  chmod(mode: number | string): Promise<void> {
    return this.host.fdPath(this.fd).then((path) => this.host.chmod(path, mode))
  }

  chown(uid: number, gid: number): Promise<void> {
    return this.host.fdPath(this.fd).then((path) => this.host.chown(path, uid, gid))
  }

  utimes(atime: unknown, mtime: unknown): Promise<void> {
    return this.host.fdPath(this.fd).then((path) => this.host.utimes(path, atime, mtime))
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.host.descriptors.close(this.fd)
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }

  createReadStream(options?: Options): unknown {
    return this.host.stream('createReadStream', null, { ...fieldsOf(options), fd: this.fd })
  }

  createWriteStream(options?: Options): unknown {
    return this.host.stream('createWriteStream', null, { ...fieldsOf(options), fd: this.fd })
  }
}

/**
 * Every routed fs call, answered on a mount: python's `HostFs` for
 * node. One method per name in `ROUTED_CALLS`, each taking the call's
 * own arguments with its path arguments already spelled as strings. The
 * calls ride `RuntimeFiles` over `ws.vfs.dispatch`, so they run as the
 * facade's session and land on `ws.vfs.records`. A call with one end on
 * a mount and the other on the host reaches the host through `native`,
 * node's own functions as they were before the patch.
 */
class HostFs implements Record<RoutedCall, (...args: never[]) => Promise<unknown>> {
  private readonly files: RuntimeFiles
  // The descriptors `open` hands out for mounted paths (descriptors.ts).
  readonly descriptors: Descriptors
  // One stamp for the patch's life, the choice python's HostFs makes: a
  // backend that reports no mtime would otherwise answer a new time on
  // every stat, and "did it change?" heuristics fire on that.
  private readonly born = Date.now()

  constructor(
    private readonly ws: Workspace,
    private readonly native: FsObject,
  ) {
    this.files = new RuntimeFiles(
      workspaceBridge(async (name, path, args, kwargs) => {
        try {
          return await ws.vfs.dispatch(name, path, args, kwargs)
        } catch (err) {
          if (classify(err) !== null) throw err
          // An op that fails with no condition (an upstream 502 a REST
          // mount throws as it came) answers EIO, the kernel's word for a
          // device that failed, as a guest's file adapter does; the original
          // rides along as the cause.
          throw Object.assign(refusal('EIO', name, path), { cause: err })
        }
      }),
      new PrefixResolver(
        () => [],
        (directory) => ws.namespace.linkNamesUnder(directory),
      ),
    )
    this.descriptors = new Descriptors(this.files, native)
  }

  /** Whether `path` is under a mount the patch answers for. The synthetic
   * root anchor matches every path but backs no files, so a path only it
   * catches stays on the host; a mount the caller put at `/` is honored.
   * A relative path names the process's working directory, which stays
   * node's whatever is mounted, and a `Buffer` spelling is the host's,
   * as a bytes path is on the python entry point. */
  mounted(path: unknown): path is string {
    if (typeof path !== 'string' || !path.startsWith('/')) return false
    const mount = this.ws.registry.tryMountFor(path)
    if (mount === null) return false
    return !(this.ws.syntheticRoot && mount === this.ws.registry.rootMount)
  }

  private statsOf(path: string, st: VFSStat, options?: Options): unknown {
    // The stat every runtime shares; an owner the row lacks is this
    // process's own.
    const posix = posixStat(st, path, this.ws.registry.tryMountFor(path)?.prefix ?? '/', {
      uid: process.getuid?.() ?? 0,
      gid: process.getgid?.() ?? 0,
      unknownMs: this.born,
    })
    const kind = posix.mode & S_IFMT
    const mtime = new Date(posix.mtimeMs)
    const atime = new Date(posix.atimeMs)
    const kinds = {
      isFile: () => kind === S_IFREG,
      isDirectory: () => kind === S_IFDIR,
      isBlockDevice: () => false,
      isCharacterDevice: () => kind === S_IFCHR,
      isSymbolicLink: () => kind === S_IFLNK,
      isFIFO: () => false,
      isSocket: () => false,
    }
    const dates = { atime, mtime, ctime: mtime, birthtime: mtime }
    const fields: Record<string, number> = {
      dev: posix.dev,
      ino: posix.ino,
      mode: posix.mode,
      nlink: posix.nlink,
      uid: posix.uid,
      gid: posix.gid,
      rdev: posix.rdev,
      size: posix.size,
      blksize: posix.blksize,
      blocks: posix.blocks,
      atimeMs: posix.atimeMs,
      mtimeMs: posix.mtimeMs,
      ctimeMs: posix.ctimeMs,
      birthtimeMs: posix.mtimeMs,
    }
    if (fieldsOf(options).bigint !== true) return { ...kinds, ...fields, ...dates }
    // node's BigIntStats: every number a bigint, plus the stamps in ns.
    const big = Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, BigInt(Math.trunc(v))]),
    )
    return {
      ...kinds,
      ...big,
      atimeNs: ns(atime),
      mtimeNs: ns(mtime),
      ctimeNs: ns(mtime),
      birthtimeNs: ns(mtime),
      ...dates,
    }
  }

  private direntOf(directory: string, row: VFSEntry): unknown {
    const kind = row.isLink === true ? S_IFLNK : row.isDir ? S_IFDIR : (row.mode ?? 0) & S_IFMT
    return {
      name: leaf(row.path),
      parentPath: directory,
      path: directory,
      isFile: () => kind === S_IFREG,
      isDirectory: () => kind === S_IFDIR,
      isBlockDevice: () => false,
      isCharacterDevice: () => kind === S_IFCHR,
      isSymbolicLink: () => kind === S_IFLNK,
      isFIFO: () => false,
      isSocket: () => false,
    }
  }

  private nativeCall(name: string, ...args: unknown[]): Promise<unknown> {
    return ((this.native.promises as FsObject)[name] as Fn)(...args) as Promise<unknown>
  }

  async access(path: string, mode = 0): Promise<void> {
    const st = await this.files.stat(path)
    // Write is the mount's mode, mirage's access control; a session's own
    // narrower grant answers when the write happens, as POSIX leaves
    // access(2) advisory. Execute is the one question the bits answer.
    if (mode & W_OK && this.ws.registry.tryMountFor(path)?.mode === MountMode.READ) {
      throw refusal('EACCES', 'access', path)
    }
    if (mode & X_OK && (st.mode & 0o111) === 0) throw refusal('EACCES', 'access', path)
  }

  async appendFile(path: string, data: unknown, options?: Options): Promise<void> {
    await this.put(path, data, options, 'a')
  }

  async chmod(path: string, mode: number | string): Promise<void> {
    await this.files.setattr(path, { mode: typeof mode === 'string' ? parseInt(mode, 8) : mode })
  }

  async lchmod(path: string, mode: number | string): Promise<void> {
    const bits = typeof mode === 'string' ? parseInt(mode, 8) : mode
    await this.files.setattr(path, { mode: bits, nofollow: true })
  }

  async chown(path: string, uid: number, gid: number, nofollow = false): Promise<void> {
    // -1 is POSIX's "leave this one alone"; passing it on would store it.
    const attrs: SetAttrFields = nofollow ? { nofollow: true } : {}
    if (uid !== -1) attrs.uid = uid
    if (gid !== -1) attrs.gid = gid
    await this.files.setattr(path, attrs)
  }

  async lchown(path: string, uid: number, gid: number): Promise<void> {
    await this.chown(path, uid, gid, true)
  }

  async copyFile(src: string, dst: string, mode = 0): Promise<void> {
    // The stored bytes, as cp copies them: a rendering is what a read
    // shows, not what the file holds.
    const data = this.mounted(src)
      ? await this.files.read(src, { raw: true })
      : await this.nativeCall('readFile', src)
    const exclusive = (mode & COPYFILE_EXCL) !== 0
    if (!this.mounted(dst)) {
      // O_EXCL on the host: the write itself refuses a name already
      // there, a dangling link included.
      await this.nativeCall('writeFile', dst, data, exclusive ? { flag: 'wx' } : undefined)
      return
    }
    // A mount has no exclusive create, so the name is looked up as `wx`
    // looks it up, the link itself rather than its target.
    if (exclusive && (await this.files.statOrNull(dst, true)) !== null) {
      throw refusal('EEXIST', 'copyfile', dst)
    }
    await this.files.write(dst, data as Uint8Array)
  }

  async exists(path: string): Promise<boolean> {
    if (!this.mounted(path)) {
      return this.nativeCall('access', path).then(
        () => true,
        (err: unknown) => {
          console.debug(`exists: ${String(err)}`)
          return false
        },
      )
    }
    // exists answers a boolean for any failure, as node's does.
    try {
      return (await this.files.statOrNull(path)) !== null
    } catch (err) {
      console.debug(`exists: ${path}: ${String(err)}`)
      return false
    }
  }

  async lstat(path: string, options?: Options): Promise<unknown> {
    return this.statsOf(path, await this.files.stat(path, true), options)
  }

  async lutimes(path: string, atime: unknown, mtime: unknown): Promise<void> {
    await this.files.setattr(path, { atime: stampOf(atime), mtime: stampOf(mtime), nofollow: true })
  }

  async mkdir(path: string, options?: Options): Promise<string | undefined> {
    if (fieldsOf(options).recursive !== true) {
      await this.files.mkdir(path)
      return undefined
    }
    // Each missing ancestor in turn, stopping at the mount root, as
    // python's makedirs does: a backend's mkdir is one level, and the
    // mount root is the deployment's own and refused (EBUSY).
    const root = (this.ws.registry.tryMountFor(path)?.prefix ?? '/').replace(/\/$/, '')
    const missing: string[] = []
    for (let probe = path.replace(/\/$/, ''); probe !== '' && probe !== '/' && probe !== root;) {
      const st = await this.files.statOrNull(probe)
      if (st !== null) {
        if (!st.isDir) throw refusal('ENOTDIR', 'mkdir', probe)
        break
      }
      missing.push(probe)
      probe = posix.dirname(probe)
    }
    // node answers the first directory it made, undefined for none.
    missing.reverse()
    for (const dir of missing) await this.files.mkdir(dir)
    return missing[0]
  }

  async readFile(path: string, options?: Options): Promise<Buffer | string> {
    const bytes = Buffer.from(await this.files.read(path))
    const encoding = encodingOf(options)
    return encoding === undefined ? bytes : bytes.toString(encoding)
  }

  async readdir(path: string, options?: Options): Promise<unknown[]> {
    const typed = fieldsOf(options).withFileTypes === true
    const recursive = fieldsOf(options).recursive === true
    const out: unknown[] = []
    const walk = async (directory: string, prefix: string): Promise<void> => {
      for (const row of await this.files.readdir(directory, typed || recursive)) {
        const name = leaf(row.path)
        out.push(typed ? this.direntOf(directory, row) : prefix + name)
        if (recursive && row.isDir && row.isLink !== true) {
          await walk(posix.join(directory, name), `${prefix}${name}/`)
        }
      }
    }
    await walk(path, '')
    return out
  }

  async readlink(path: string, options?: Options): Promise<Buffer | string> {
    const target = await this.files.readlink(path)
    const encoding = encodingOf(options) as string | undefined
    if (encoding === undefined || encoding === 'utf8') return target
    const bytes = Buffer.from(target)
    return encoding === 'buffer' ? bytes : bytes.toString(encoding as BufferEncoding)
  }

  async rename(src: string, dst: string): Promise<void> {
    // A move between a mount and the host is EXDEV, the kernel's answer
    // for two filesystems and the errno a mover retries as copy + delete.
    if (!this.mounted(src) || !this.mounted(dst)) throw refusal('EXDEV', 'rename', src)
    // A rename onto its own name changes nothing, its descriptors included.
    const held = dst === src ? [] : await this.descriptors.hold(dst)
    await this.files.rename(src, dst)
    this.descriptors.keep(held)
    this.descriptors.moved(src, dst)
  }

  /** Remove a file, the descriptors open on it keeping the bytes it had. */
  private async removeFile(path: string): Promise<void> {
    const held = await this.descriptors.hold(path)
    await this.files.unlink(path)
    this.descriptors.keep(held)
  }

  async rm(path: string, options?: Options): Promise<void> {
    const force = fieldsOf(options).force === true
    const recursive = fieldsOf(options).recursive === true
    // A mount root is refused however it is spelled (`/data/.`), before
    // the stat a backend may answer for that spelling or not.
    if (this.ws.registry.isMountRoot(posix.normalize(path))) throw refusal('EBUSY', 'rm', path)
    let st: VFSStat
    try {
      st = await this.files.stat(path, true)
    } catch (err) {
      if (!force || !isMissingPath(err)) throw err
      console.debug(`rm: ${path} is already gone: ${String(err)}`)
      return
    }
    if (!st.isDir) {
      await this.removeFile(path)
      return
    }
    if (!recursive) throw refusal('EISDIR', 'rm', path)
    const doomed: [string, boolean, string][] = []
    await this.plan(path, true, doomed, path, this.ws.namespace.follow(path))
    // A name another writer removed since the plan is already gone, as
    // node's own recursive rm counts it.
    for (const [name, isDir, where] of doomed) {
      this.held(posix.dirname(name), posix.dirname(where))
      try {
        if (isDir) await this.files.rmdir(name)
        else await this.removeFile(name)
      } catch (err) {
        if (!isMissingPath(err) || name === path) throw err
        console.debug(`rm: ${name} went before its turn: ${String(err)}`)
      }
    }
  }

  /** Every name under `path` onto `out`, children before their directory,
   * each with where it resolved when planned. The whole tree is planned
   * before anything goes, as the agent adapters plan it, so a mount root
   * anywhere in it refuses the call with nothing removed. */
  private async plan(
    path: string,
    isDir: boolean,
    out: [string, boolean, string][],
    top: string,
    where: string,
  ): Promise<void> {
    if (this.ws.registry.isMountRoot(posix.normalize(path))) throw refusal('EBUSY', 'rm', path)
    if (isDir) {
      this.held(path, where)
      let rows: VFSEntry[]
      try {
        rows = await this.files.readdir(path)
      } catch (err) {
        if (!isMissingPath(err) || path === top) throw err
        console.debug(`rm: ${path} went while the tree was planned: ${String(err)}`)
        return
      }
      for (const row of rows) {
        const name = leaf(row.path)
        const isChildDir = row.isDir && row.isLink !== true
        await this.plan(posix.join(path, name), isChildDir, out, top, posix.join(where, name))
      }
    }
    out.push([path, isDir, where])
  }

  /** Refuse to act in `directory` once it resolves elsewhere than `where`,
   * where the plan found it: swapped for a link, or under an ancestor
   * that was, a name in it would reach the link's target. A name is all
   * a mount gives, so this check stands in for the descriptor a host
   * walk would hold. */
  private held(directory: string, where: string): void {
    if (posix.normalize(this.ws.namespace.follow(directory)) !== posix.normalize(where)) {
      throw refusal('ELOOP', 'rm', directory)
    }
  }

  async rmdir(path: string): Promise<void> {
    // rmdir(2) on a mount point is EBUSY. A mount root is the
    // deployment's own, which the shell's rm refuses the same way.
    if (this.ws.registry.isMountRoot(posix.normalize(path))) {
      throw refusal('EBUSY', 'rmdir', path)
    }
    await this.files.rmdir(path)
  }

  async stat(path: string, options?: Options): Promise<unknown> {
    return this.statsOf(path, await this.files.stat(path), options)
  }

  async symlink(target: unknown, path: string): Promise<void> {
    await this.files.symlink(path, String(target))
  }

  async truncate(path: string, length = 0): Promise<void> {
    // truncate(2) names a file that is there; the op creates a missing
    // one, as GNU truncate does without -c.
    await this.files.stat(path)
    await this.files.truncate(path, length)
  }

  async unlink(path: string): Promise<void> {
    await this.removeFile(path)
  }

  async utimes(path: string, atime: unknown, mtime: unknown): Promise<void> {
    // Writes a descriptor still owes land first, or landing them at its
    // close would stamp over the times set here.
    await this.descriptors.landPath(path)
    await this.files.setattr(path, { atime: stampOf(atime), mtime: stampOf(mtime) })
  }

  async writeFile(path: string, data: unknown, options?: Options): Promise<void> {
    await this.put(path, data, options, 'w')
  }

  /** readFile, writeFile or appendFile given a mounted descriptor or
   * FileHandle: from and at its position, as node's are on a descriptor. */
  async fileCall(name: string, target: unknown, rest: unknown[]): Promise<unknown> {
    const fd = target instanceof MountedFileHandle ? target.fd : (target as number)
    if (name === 'readFile') {
      const bytes = Buffer.from(await this.fdReadAll(fd))
      const encoding = encodingOf(rest[0] as Options)
      return encoding === undefined ? bytes : bytes.toString(encoding)
    }
    await this.fdWrite(fd, bytesOf(rest[0], rest[1] as Options), null)
    return undefined
  }

  /** A mounted path's `FileHandle`, as `fs.promises.open` answers. */
  async open(path: string, flags?: unknown): Promise<MountedFileHandle> {
    return new MountedFileHandle(this, await this.descriptors.open(path, openFlags(flags)))
  }

  /** The path a mounted descriptor opened. */
  fdPath(fd: number): Promise<string> {
    const desc = this.descriptors.get(fd)
    return desc === undefined ? Promise.reject(ebadf(String(fd))) : Promise.resolve(desc.path)
  }

  /** A read through a mounted descriptor, in its turn on the descriptor. */
  fdRead(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ): Promise<number> {
    return this.descriptors.serial(fd, () => this.readInto(fd, buffer, offset, length, position))
  }

  /** A write through a mounted descriptor, in its turn on the descriptor. */
  fdWrite(fd: number, bytes: Uint8Array, position: number | null): Promise<number> {
    return this.descriptors.serial(fd, () => Promise.resolve(this.writeFrom(fd, bytes, position)))
  }

  /** The rest of a mounted descriptor's file from its position. */
  fdReadAll(fd: number): Promise<Uint8Array> {
    return this.descriptors.serial(fd, () => readOn(this.descriptors.file(fd, true, false), -1))
  }

  fdTruncate(fd: number, length: number): Promise<void> {
    return this.descriptors.serial(fd, () => {
      this.descriptors.file(fd, false, true).truncate(length)
      return Promise.resolve()
    })
  }

  private async readInto(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ): Promise<number> {
    const handle = this.descriptors.file(fd, true, false)
    const bytes =
      position === null ? await readOn(handle, length) : await readAt(handle, position, length)
    buffer.set(bytes, offset)
    return bytes.byteLength
  }

  private writeFrom(fd: number, bytes: Uint8Array, position: number | null): number {
    const handle = this.descriptors.file(fd, false, true)
    if (position === null) handle.write(bytes.slice())
    else handle.pwrite(position, bytes.slice())
    return bytes.byteLength
  }

  async fdStat(fd: number, options?: Options): Promise<unknown> {
    const desc = this.descriptors.get(fd)
    if (desc === undefined) throw ebadf(String(fd))
    const st = await this.files.stat(desc.path)
    return this.statsOf(desc.path, { ...st, size: desc.handle?.size ?? st.size }, options)
  }

  fdSync(fd: number): Promise<void> {
    const desc = this.descriptors.get(fd)
    if (desc === undefined) return Promise.reject(ebadf(String(fd)))
    return this.descriptors.serial(fd, () => this.descriptors.land(desc))
  }

  /** A descriptor call on a mounted descriptor, answered with what node's
   * callback gets after its error slot. */
  async descriptorCall(name: string, args: unknown[]): Promise<unknown[]> {
    const fd = args[0] as number
    const rest = args.slice(1)
    switch (name) {
      case 'read': {
        const [buffer, offset, length, position, original] = readArgs(rest)
        return [await this.fdRead(fd, buffer, offset, length, position), original]
      }
      case 'write': {
        const [bytes, position] = writeArgs(rest[0], rest.slice(1))
        return [await this.fdWrite(fd, bytes, position), rest[0]]
      }
      case 'readv':
        return this.descriptors.serial(fd, async () => {
          const buffers = rest[0] as Uint8Array[]
          let at = positionOf(rest[1] as number | null | undefined)
          let total = 0
          for (const buffer of buffers) {
            const got = await this.readInto(fd, buffer, 0, buffer.byteLength, at)
            total += got
            if (at !== null) at += got
            if (got < buffer.byteLength) break
          }
          return [total, buffers]
        })
      case 'writev': {
        const buffers = rest[0] as Uint8Array[]
        const position = positionOf(rest[1] as number | null | undefined)
        const joined = Buffer.concat(buffers.map((b) => bytesOf(b, null)))
        return [await this.fdWrite(fd, joined, position), buffers]
      }
      case 'fstat':
        return [await this.fdStat(fd, rest[0] as Options)]
      case 'ftruncate':
        await this.fdTruncate(fd, Number(rest[0] ?? 0))
        return []
      case 'fsync':
      case 'fdatasync':
        await this.fdSync(fd)
        return []
      case 'close':
        await this.descriptors.close(fd)
        return []
      case 'fchmod':
        await this.chmod(await this.fdPath(fd), rest[0] as number)
        return []
      case 'fchown':
        await this.chown(await this.fdPath(fd), rest[0] as number, rest[1] as number)
        return []
      case 'futimes':
        await this.utimes(await this.fdPath(fd), rest[0], rest[1])
        return []
      default:
        throw new TypeError(`mirage.patchNodeFs: ${name} is not a descriptor call`)
    }
  }

  /** node's own read or write stream over a mounted path or descriptor,
   * its descriptor calls answered here through the `fs` option. */
  stream(
    name: 'createReadStream' | 'createWriteStream',
    path: string | null,
    options: Record<string, unknown>,
  ): unknown {
    const fs = {
      open: (target: string, flags: unknown, _mode: unknown, done: Fn): void => {
        answer(
          this.descriptors.open(target, openFlags(flags)).then((fd) => [fd]),
          done,
        )
      },
      read: (
        fd: number,
        buffer: Uint8Array,
        offset: number,
        length: number,
        position: number | bigint | null,
        done: Fn,
      ): void => {
        answer(
          this.fdRead(fd, buffer, offset, length, positionOf(position)).then((n) => [n, buffer]),
          done,
        )
      },
      write: (
        fd: number,
        buffer: Uint8Array,
        offset: number,
        length: number,
        position: number | null,
        done: Fn,
      ): void => {
        answer(
          this.fdWrite(fd, buffer.subarray(offset, offset + length), positionOf(position)).then(
            (n) => [n, buffer],
          ),
          done,
        )
      },
      close: (fd: number, done: Fn): void => {
        answer(
          this.descriptors.close(fd).then(() => []),
          done,
        )
      },
    }
    return (this.native[name] as Fn)(path, { ...options, fs })
  }

  /** writeFile and appendFile, which differ only in the flag they default
   * to. An exclusive flag (`wx`, `ax`) refuses a name already there
   * before anything is written. */
  private async put(
    path: string,
    data: unknown,
    options: Options,
    fallback: string,
  ): Promise<void> {
    const given = fieldsOf(options).flag
    const flag = typeof given === 'string' ? given : fallback
    const bytes = bytesOf(data, options)
    if (flag.includes('x') && (await this.files.statOrNull(path, true)) !== null) {
      throw refusal('EEXIST', 'open', path)
    }
    if (flag.startsWith('a')) await this.files.append(path, bytes)
    else await this.files.write(path, bytes)
  }
}

/**
 * Point node's own `fs` at the workspace for every mounted path.
 *
 * Each name in `constants.ts` is swapped on the CommonJS `fs` object
 * and on `fs.promises`, in all the spellings node has: a routed call
 * goes through the workspace, a refused one answers its condition, and
 * a sync spelling refuses a mounted path, since the workspace answers
 * asynchronously. A path no mount owns reaches node's own function in
 * every spelling, so the rest of the process keeps its filesystem. ESM
 * named imports of `node:fs/promises` keep node's functions: an ES
 * module binds them at link time, which is also why a node backend's
 * own host I/O never routes back into the workspace.
 *
 * Returns a `restore()` that puts every swapped function back.
 */
export function patchNodeFs(ws: Workspace): () => void {
  const native: FsObject = { ...fs, promises: { ...fs.promises } }
  const host = new HostFs(ws, native)
  const swapped: [FsObject, string, unknown][] = []
  const swap = (target: FsObject, name: string, make: (original: Fn) => Fn): void => {
    const original = target[name]
    if (typeof original !== 'function') return
    swapped.push([target, name, original])
    const wrapped = make(original as Fn)
    // node hangs helpers off a few functions (`realpath.native`, the
    // promisify hooks), and they stay: a named one is swapped the same
    // way, a symbol one is node's and calls back through `fs`.
    for (const key of Reflect.ownKeys(original)) {
      if (key === 'length' || key === 'name' || key === 'prototype') continue
      const helper: unknown = Reflect.get(original, key)
      const own = typeof key === 'string' && typeof helper === 'function'
      Reflect.set(wrapped, key, own ? make(helper as Fn) : helper)
    }
    target[name] = wrapped
  }
  // The paths a call names. glob names one per pattern, a relative one
  // under its `cwd`.
  const namedPaths = (name: string, args: unknown[]): (string | null)[] => {
    if (name !== 'glob') return (PATH_ARGS[name] ?? [0]).map((index) => spelled(args[index]))
    const cwd = spelled(fieldsOf(args[1] as Options).cwd)
    const patterns: unknown[] = Array.isArray(args[0]) ? args[0] : [args[0]]
    return patterns.map((pattern) => {
      const path = spelled(pattern)
      if (path === null || cwd === null || posix.isAbsolute(path)) return path
      return posix.join(cwd, path)
    })
  }
  // The mounted path a call names, or null when every path it takes is
  // the host's, which leaves the call to node.
  const mountedIn = (name: string, args: unknown[]): string | null =>
    namedPaths(name, args).find((path) => host.mounted(path)) ?? null
  const spellPaths = (name: string, args: unknown[]): unknown[] => {
    const positions = PATH_ARGS[name] ?? [0]
    return args.map((arg, index) => (positions.includes(index) ? (spelled(arg) ?? arg) : arg))
  }

  // readFile, writeFile and appendFile take a descriptor or a FileHandle
  // where they take a path: a mounted one of the patch's is answered here.
  const byDescriptor = (name: string, args: unknown[]): boolean =>
    FILE_CALLS.has(name) &&
    (host.descriptors.get(args[0]) !== undefined || args[0] instanceof MountedFileHandle)
  for (const name of ROUTED_CALLS) {
    const route = (args: unknown[]): Promise<unknown> =>
      (host[name] as (...a: unknown[]) => Promise<unknown>).call(host, ...spellPaths(name, args))
    swap(fs.promises, name, (original) => (...args) => {
      if (byDescriptor(name, args)) return host.fileCall(name, args[0], args.slice(1))
      return mountedIn(name, args) === null ? original(...args) : route(args)
    })
    swap(fs, name, (original) => (...args) => {
      const done = args.at(-1)
      const rest = args.slice(0, -1)
      if (typeof done === 'function' && byDescriptor(name, rest)) {
        answer(
          host.fileCall(name, rest[0], rest.slice(1)).then((v) => (v === undefined ? [] : [v])),
          done as Fn,
        )
        return undefined
      }
      if (typeof done !== 'function' || mountedIn(name, rest) === null) return original(...args)
      const callback = done as Callback
      // `exists` is the one callback without an error slot.
      route(rest).then(
        (value) => {
          if (name === 'exists') callback(value)
          else callback(null, value)
        },
        (err: unknown) => {
          if (name === 'exists') callback(false)
          else callback(err)
        },
      )
      return undefined
    })
    swap(fs, `${name}Sync`, (original) => (...args) => {
      const desc = host.descriptors.get(args[0])
      if (desc !== undefined && FILE_CALLS.has(name)) throw syncRefusal(`${name}Sync`, desc.path)
      const path = mountedIn(name, args)
      if (path === null) return original(...args)
      // existsSync answers false where it cannot look, as node's does for
      // any path whose stat fails; a mount's root is the one name it
      // knows is there without asking.
      if (name === 'exists') return ws.registry.isMountRoot(path)
      throw syncRefusal(`${name}Sync`, path)
    })
  }

  // open hands a mounted path a descriptor of the patch's own, which the
  // descriptor calls below answer for; the promise spelling a FileHandle.
  swap(fs.promises, 'open', (original) => (...args) => {
    const path = mountedIn('open', args)
    return path === null ? original(...args) : host.open(path, args[1])
  })
  swap(fs, 'open', (original) => (...args) => {
    const done = args.at(-1)
    const rest = args.slice(0, -1)
    const path = mountedIn('open', rest)
    if (typeof done !== 'function' || path === null) return original(...args)
    answer(
      host.descriptors.open(path, openFlags(rest[1])).then((fd) => [fd]),
      done as Fn,
    )
    return undefined
  })
  swap(fs, 'openSync', (original) => (...args) => {
    const path = mountedIn('open', args)
    if (path !== null) throw syncRefusal('openSync', path)
    return original(...args)
  })
  for (const name of ['createReadStream', 'createWriteStream'] as const) {
    swap(fs, name, (original) => (...args) => {
      const path = mountedIn(name, args)
      if (path === null) return original(...args)
      const given = args[1] as Options
      const options = typeof given === 'string' ? { encoding: given } : fieldsOf(given)
      return host.stream(name, path, options)
    })
  }

  for (const name of DESCRIPTOR_CALLS) {
    swap(fs, name, (original) => (...args) => {
      if (host.descriptors.get(args[0]) === undefined) return original(...args)
      const done = args.at(-1)
      // fs.close is the one whose callback node lets a caller leave out;
      // a failure then has nowhere to go but the log.
      const callback: Fn =
        typeof done === 'function'
          ? (done as Fn)
          : (err: unknown) => {
              if (err !== null) console.debug(`mirage.patchNodeFs: ${name} failed`, err)
            }
      answer(
        host.descriptorCall(name, typeof done === 'function' ? args.slice(0, -1) : args),
        callback,
      )
      return undefined
    })
    swap(fs, `${name}Sync`, (original) => (...args) => {
      const desc = host.descriptors.get(args[0])
      if (desc !== undefined) throw syncRefusal(`${name}Sync`, desc.path)
      return original(...args)
    })
  }

  for (const [name, condition] of Object.entries(REFUSED_CALLS)) {
    swap(fs.promises, name, (original) => {
      const iterated =
        Object.prototype.toString.call(original) === '[object AsyncGeneratorFunction]'
      return (...args) => {
        const path = mountedIn(name, args)
        if (path === null) return original(...args)
        const err = refusal(condition, name, path)
        return iterated ? refusedIterator(err) : Promise.reject(err)
      }
    })
    swap(fs, name, (original) => (...args) => {
      const path = mountedIn(name, args)
      if (path === null) return original(...args)
      const err = refusal(condition, name, path)
      const done = args.at(-1)
      if (typeof done !== 'function' || LISTENED_CALLS.has(name)) throw err
      process.nextTick(done as Callback, err)
      return undefined
    })
    swap(fs, `${name}Sync`, (original) => (...args) => {
      const path = mountedIn(name, args)
      if (path !== null) throw refusal(condition, `${name}Sync`, path)
      return original(...args)
    })
  }

  return function restore(): void {
    for (const [target, name, original] of swapped.reverse()) target[name] = original
  }
}
