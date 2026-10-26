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
import { randomBytes } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import type * as fsPromises from 'node:fs/promises'
import { createRequire } from 'node:module'
import { posix } from 'node:path'
import { type Interface, createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { classify } from '@struktoai/mirage-core/errors/classify'
import { ebadf, einval, isMissingPath } from '@struktoai/mirage-core/errors/fs'
import { posixErrno, posixPhrase } from '@struktoai/mirage-core/errors/posix'
import type { FsCondition } from '@struktoai/mirage-core/errors/types'
import { linkView } from '@struktoai/mirage-core/commands/builtin/utils/links'
import { workspaceBridge } from '@struktoai/mirage-core/runtime/binding'
import { MountCore } from '@struktoai/mirage-core/mount/core'
import { type Descriptor, RuntimeFiles } from '@struktoai/mirage-core/runtime/files'
import { openMode } from '@struktoai/mirage-core/runtime/handles/mode'
import { posixStat } from '@struktoai/mirage-core/runtime/stat'
import { PrefixResolver } from '@struktoai/mirage-core/runtime/resolver'
import type { VFSEntry, VFSStat } from '@struktoai/mirage-core/runtime/types'
import { MountMode, type SetAttrFields } from '@struktoai/mirage-core/types'
import { MAX_SYMLINK_HOPS } from '@struktoai/mirage-core/utils/path'
import { entryName } from '@struktoai/mirage-core/utils/remnants'
import { pathMode } from '@struktoai/mirage-core/workspace/files'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import {
  DESCRIPTOR_CALLS,
  LISTENED_CALLS,
  PATH_ARGS,
  REFUSED_CALLS,
  ROUTED_CALLS,
  type RoutedCall,
} from './constants.ts'
import { Descriptors, openFlags } from './descriptors.ts'
import { dirent, openedDir } from './list.ts'
import { stats } from './stat.ts'

type FsObject = Record<string, unknown>
type Fn = (...args: unknown[]) => unknown
type Callback = (err: unknown, value?: unknown) => void
type Options = Record<string, unknown> | string | number | null | undefined

const fs = createRequire(import.meta.url)('node:fs') as FsObject & { promises: FsObject }
// fs.promises as the patch leaves it, each call looked up when it is
// made: a call on it reaches node for a host path and the workspace for
// a mounted one, so a cp or glob across the two takes each end where it is.
const routed = fs.promises as unknown as typeof fsPromises
const { W_OK, X_OK, COPYFILE_EXCL } = constants

/** `path` as a string a mount could serve, or null: a descriptor and a
 * Buffer are host spellings no mount uses. */
function spelled(path: unknown): string | null {
  if (typeof path === 'string') return path
  if (path instanceof URL && path.protocol === 'file:') return fileURLToPath(path)
  return null
}

/** A refusal spelled the way node's own fs spells an error. */
function refusal(condition: FsCondition, syscall: string, path: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(
    `${condition}: ${posixPhrase(condition).toLowerCase()}, ${syscall} '${path}'`,
  )
  err.code = condition
  err.errno = -posixErrno(condition)
  err.syscall = syscall
  err.path = path
  return err
}

function fsError(error: unknown, syscall: string, path?: string): Error {
  const condition = classify(error)
  if (condition === null)
    return error instanceof Error ? error : new Error(String(error), { cause: error })
  const converted = refusal(condition, syscall, path ?? '')
  if (path === undefined) {
    converted.message = `${condition}: ${posixPhrase(condition).toLowerCase()}, ${syscall}`
    delete converted.path
  }
  return Object.assign(converted, { cause: error })
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

/** A name as node answers one: a string, or a Buffer or another
 * encoding where the options ask for it. */
function encoded(text: string, options: Options): Buffer | string {
  const encoding = encodingOf(options) as string | undefined
  if (encoding === undefined || encoding === 'utf8') return text
  const bytes = Buffer.from(text)
  return encoding === 'buffer' ? bytes : bytes.toString(encoding as BufferEncoding)
}

/** One of node's own `cp` refusals (`ERR_FS_CP_*`), spelled as node spells it. */
function cpRefusal(
  code: string,
  title: string,
  condition: FsCondition,
  detail: string,
  path: string,
): Error {
  return Object.assign(new Error(`${title}: cp returned ${condition} (${detail}) ${path}`), {
    code,
    errno: posixErrno(condition),
    syscall: 'cp',
    path,
  })
}

/** Six characters from the alphabet of node's `mkdtemp` template. */
function tempSuffix(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  return Array.from(randomBytes(6), (byte) => alphabet[byte % alphabet.length]).join('')
}

// A path segment holding a character node's glob matcher reads as one.
const GLOB_MAGIC = /[*?[\]{}()!+@]/

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

/** Every item an async iterator yields. */
async function collected(items: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const item of items) out.push(item)
  return out
}

/** A time argument (seconds, a numeric string, a Date) as the ISO stamp
 * setattr stores. */
function stampOf(time: unknown): string {
  const ms = time instanceof Date ? time.getTime() : Number(time) * 1000
  return new Date(ms).toISOString()
}

/** Refuse an integer argument outside `[min, max]` as node does. */
function checkRange(name: string, value: number, max: number, min = 0): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw Object.assign(
      new RangeError(
        `The value of "${name}" is out of range. It must be >= ${String(min)} && <= ${String(max)}. Received ${String(value)}`,
      ),
      { code: 'ERR_OUT_OF_RANGE' },
    )
  }
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
  checkRange('offset', offset, buffer.length)
  checkRange('length', length, buffer.length - offset)
  if (typeof position === 'number' || typeof position === 'bigint')
    checkRange('position', Number(position), Number.MAX_SAFE_INTEGER, -1)
  return [buffer, offset, length, positionOf(position), original]
}

/** A write's bytes and where they go, out of node's write spellings:
 * `(buffer, offset, length, position)`, `(buffer, options)` and
 * `(string, position, encoding)`. */
function writeArgs(data: unknown, rest: unknown[]): [Uint8Array, number | null] {
  if (typeof data === 'string') {
    const encoding = (typeof rest[1] === 'string' ? rest[1] : 'utf8') as BufferEncoding
    return [Buffer.from(data, encoding), positionOf(rest[0])]
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

/** A position argument as an offset, or null for "at the position": node
 * reads anything but a number there (`fs.write(fd, 'x', 'utf8', cb)`'s
 * encoding included) and a negative one as the descriptor's position. */
function positionOf(position: unknown): number | null {
  if (typeof position !== 'number' && typeof position !== 'bigint') return null
  const at = Number(position)
  return Number.isNaN(at) || at < 0 ? null : at
}

/**
 * The `FileHandle` `fs.promises.open` answers a mounted path with: node's
 * own methods over a descriptor of the patch's, whose writes land at
 * `close` or `sync`. It holds the descriptor it opened, not just its
 * number: once that is closed, here or through `fs.close`, every call is
 * EBADF, even after a later open takes the number.
 */
class MountedFileHandle {
  private closed = false

  constructor(
    private readonly host: HostFs,
    readonly fd: number,
    private readonly desc: Descriptor | undefined,
  ) {}

  /** Whether the descriptor this handle opened is still open. */
  live(): boolean {
    return (
      !this.closed && this.desc !== undefined && this.host.descriptors.get(this.fd) === this.desc
    )
  }

  /** A descriptor call on this handle's descriptor; EBADF once it closed. */
  private call(name: string, ...args: unknown[]): Promise<unknown[]> {
    if (!this.live()) return Promise.reject(fsError(ebadf(String(this.fd)), name))
    return this.host.descriptorCall(name, [this.fd, ...args])
  }

  async read(...args: unknown[]): Promise<{ bytesRead: number; buffer: unknown }> {
    const [bytesRead, buffer] = await this.call('read', ...args)
    return { bytesRead: bytesRead as number, buffer }
  }

  async readv(
    buffers: Uint8Array[],
    position?: number | null,
  ): Promise<{ bytesRead: number; buffers: Uint8Array[] }> {
    const [bytesRead] = await this.call('readv', buffers, position)
    return { bytesRead: bytesRead as number, buffers }
  }

  async write(...args: unknown[]): Promise<{ bytesWritten: number; buffer: unknown }> {
    const [bytesWritten, buffer] = await this.call('write', ...args)
    return { bytesWritten: bytesWritten as number, buffer }
  }

  async writev(
    buffers: Uint8Array[],
    position?: number | null,
  ): Promise<{ bytesWritten: number; buffers: Uint8Array[] }> {
    const [bytesWritten] = await this.call('writev', buffers, position)
    return { bytesWritten: bytesWritten as number, buffers }
  }

  readFile(options?: Options): Promise<unknown> {
    return this.host.fileCall('readFile', this, [options])
  }

  async writeFile(data: unknown, options?: Options): Promise<void> {
    await this.host.fileCall('writeFile', this, [data, options])
  }

  appendFile(data: unknown, options?: Options): Promise<void> {
    return this.writeFile(data, options)
  }

  async stat(options?: Options): Promise<unknown> {
    return (await this.call('fstat', options))[0]
  }

  async truncate(len = 0): Promise<void> {
    await this.call('ftruncate', len)
  }

  async sync(): Promise<void> {
    await this.call('fsync')
  }

  async datasync(): Promise<void> {
    await this.call('fdatasync')
  }

  async chmod(mode: number | string): Promise<void> {
    await this.call('fchmod', mode)
  }

  async chown(uid: number, gid: number): Promise<void> {
    await this.call('fchown', uid, gid)
  }

  async utimes(atime: unknown, mtime: unknown): Promise<void> {
    await this.call('futimes', atime, mtime)
  }

  async close(): Promise<void> {
    const live = this.live()
    this.closed = true
    if (live) await this.host.descriptorCall('close', [this.fd])
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }

  // node's streams call back through `fs.read`, `fs.write` and `fs.close`,
  // which the patch answers for this descriptor.
  createReadStream(options?: Options): unknown {
    if (!this.live()) throw ebadf(String(this.fd))
    return (fs.createReadStream as Fn)(null, { ...fieldsOf(options), fd: this.fd })
  }

  createWriteStream(options?: Options): unknown {
    if (!this.live()) throw ebadf(String(this.fd))
    return (fs.createWriteStream as Fn)(null, { ...fieldsOf(options), fd: this.fd })
  }

  // node's own reads its lines through createReadStream, as this does.
  readLines(options?: Options): Interface {
    return createInterface({
      input: this.createReadStream(options) as NodeJS.ReadableStream,
      crlfDelay: Infinity,
    })
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
class HostFs implements Record<
  RoutedCall,
  (...args: never[]) => Promise<unknown> | AsyncIterable<unknown>
> {
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
    // An op that fails with no condition (an upstream 502 a REST mount
    // throws as it came) answers EIO, the kernel's word for a device that
    // failed, as a guest's file adapter does; the original rides along as
    // the cause.
    const dispatch: typeof ws.vfs.dispatch = async (name, path, args, kwargs, report) => {
      try {
        return await ws.vfs.dispatch(name, path, args, kwargs, report)
      } catch (err) {
        if (classify(err) !== null) throw err
        throw Object.assign(refusal('EIO', name, typeof path === 'string' ? path : path.virtual), {
          cause: err,
        })
      }
    }
    // Where a link leads, so a file reads as one inode whichever spelling
    // reached it.
    const links = linkView(ws.vfs)
    this.files = new RuntimeFiles(
      workspaceBridge(
        async (name, path, args, kwargs) => (await dispatch(name, path, args, kwargs))[0],
      ),
      new PrefixResolver(
        () => [],
        (directory) => ws.namespace.linkNamesUnder(directory),
      ),
      links === undefined ? null : links.resolve.bind(links),
      new MountCore(ws.vfs.over(dispatch)),
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

  private statsOf(path: string, st: VFSStat, options?: Options, unlinked = false): unknown {
    // The stat every runtime shares; an owner the row lacks is this
    // process's own.
    // The file the links lead to names both its inode and its device, so a
    // stat through a link and the fstat of its open file agree.
    const named = st.name ?? path
    const posix = posixStat(st, named, this.ws.registry.tryMountFor(named)?.prefix ?? '/', {
      uid: process.getuid?.() ?? 0,
      gid: process.getgid?.() ?? 0,
      unknownMs: this.born,
    })
    return stats(unlinked ? { ...posix, nlink: 0 } : posix, fieldsOf(options).bigint === true)
  }

  /**
   * Whether a write at `path` would be admitted by mode: the mode the write
   * itself meets (`pathMode`). Mirrors Python's `_writable`.
   */
  private async writable(path: string): Promise<boolean> {
    const mode = await pathMode(this.ws.vfs, path)
    return mode !== null && mode !== MountMode.READ
  }

  private nativeCall(name: string, ...args: unknown[]): Promise<unknown> {
    return ((this.native.promises as FsObject)[name] as Fn)(...args) as Promise<unknown>
  }

  async access(path: string, mode = 0): Promise<void> {
    const st = await this.files.stat(path)
    // Write is the mode in force at the path for the session, mirage's
    // access control: W_OK answers what the write itself would meet, as
    // access(2) refuses a write on a read-only file system. Execute is the
    // one question the bits answer.
    if (mode & W_OK && !(await this.writable(path))) throw refusal('EACCES', 'access', path)
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

  async cp(src: string, dst: string, options?: Options): Promise<void> {
    const opts = fieldsOf(options)
    const filter = opts.filter as ((from: string, to: string) => unknown) | undefined
    if (filter !== undefined && !(await filter(src, dst))) return
    // node compares the two files, so a link that makes them one is
    // caught as one spelling is.
    const follow = opts.dereference === true
    const [source, target] = [await this.identity(src, follow), await this.identity(dst, follow)]
    if (source === target) {
      throw cpRefusal(
        'ERR_FS_CP_EINVAL',
        'Invalid src or dest',
        'EINVAL',
        'src and dest cannot be the same',
        dst,
      )
    }
    const from = await this.entryOf(src, follow)
    if (from.isDirectory()) {
      if (opts.recursive !== true) {
        throw cpRefusal(
          'ERR_FS_EISDIR',
          'Path is a directory',
          'EISDIR',
          `${src} is a directory (not copied)`,
          src,
        )
      }
      if (target.startsWith(`${source}/`)) {
        throw cpRefusal(
          'ERR_FS_CP_EINVAL',
          'Invalid src or dest',
          'EINVAL',
          `cannot copy ${src} to a subdirectory of self ${dst}`,
          dst,
        )
      }
    }
    // node makes the destination's missing parents first.
    const parent = posix.dirname(posix.resolve(dst))
    try {
      await routed.stat(parent)
    } catch (err) {
      if (!isMissingPath(err)) throw err
      await routed.mkdir(parent, { recursive: true })
    }
    await this.copied(src, dst, from, opts)
  }

  /** The file `path` names once its links are followed, as node's `cp`
   * tells two files apart: its directories always, its last name when
   * `follow`, and a name not there as it is spelled. */
  private async identity(path: string, follow: boolean): Promise<string> {
    const absolute = posix.resolve(path)
    if (absolute === '/') return absolute
    if (follow) {
      try {
        return await routed.realpath(absolute)
      } catch (err) {
        if (!isMissingPath(err)) throw err
      }
    }
    return posix.join(await this.identity(posix.dirname(absolute), true), posix.basename(absolute))
  }

  /** A path's own entry, or its target's, through the patched calls, so
   * a host path reaches node and a mounted one the workspace. */
  private entryOf(path: string, follow: boolean): Promise<Stats> {
    return follow ? routed.stat(path) : routed.lstat(path)
  }

  /** One entry of a `cp` and what is under it, as node's own copies it:
   * a name already there is replaced unless `force` is off, and a link
   * keeps its target, a relative one resolved against where it was. */
  private async copied(
    src: string,
    dst: string,
    from: Stats,
    opts: Record<string, unknown>,
  ): Promise<void> {
    let to: Stats | null = null
    try {
      to = await this.entryOf(dst, false)
    } catch (err) {
      if (!isMissingPath(err)) throw err
    }
    if (from.isDirectory()) {
      if (to !== null && !to.isDirectory()) {
        throw cpRefusal(
          'ERR_FS_CP_DIR_TO_NON_DIR',
          'Cannot overwrite non-directory with directory',
          'EISDIR',
          `cannot overwrite non-directory ${dst} with directory ${src}`,
          dst,
        )
      }
      if (to === null) await routed.mkdir(dst)
      const filter = opts.filter as ((from: string, to: string) => unknown) | undefined
      for (const name of await routed.readdir(src)) {
        const [child, target] = [posix.join(src, name), posix.join(dst, name)]
        if (filter !== undefined && !(await filter(child, target))) continue
        await this.copied(child, target, await this.entryOf(child, opts.dereference === true), opts)
      }
      // A directory it made takes the source's mode, once its entries are in.
      if (to === null) await routed.chmod(dst, from.mode & 0o7777)
      return
    }
    if (to?.isDirectory() === true) {
      throw cpRefusal(
        'ERR_FS_CP_NON_DIR_TO_DIR',
        'Cannot overwrite directory with non-directory',
        'ENOTDIR',
        `cannot overwrite directory ${dst} with non-directory ${src}`,
        dst,
      )
    }
    if (to !== null) {
      if (opts.force === false) {
        if (opts.errorOnExist !== true) return
        throw cpRefusal(
          'ERR_FS_CP_EEXIST',
          'Target already exists',
          'EEXIST',
          `${dst} already exists`,
          dst,
        )
      }
      await routed.unlink(dst)
    }
    if (from.isSymbolicLink()) {
      const target = await routed.readlink(src)
      const kept =
        opts.verbatimSymlinks === true || posix.isAbsolute(target)
          ? target
          : posix.resolve(posix.dirname(src), target)
      await routed.symlink(kept, dst)
      return
    }
    await routed.copyFile(src, dst, typeof opts.mode === 'number' ? opts.mode : 0)
    if (opts.preserveTimestamps === true) await routed.utimes(dst, from.atime, from.mtime)
    await routed.chmod(dst, from.mode & 0o7777)
  }

  /** The names `pattern` matches, as node's `fs.promises.glob` yields
   * them: by node's own matcher, under the part of the pattern that has
   * no wildcard, relative to `cwd` for a relative pattern. */
  async *glob(pattern: unknown, options?: Options): AsyncGenerator {
    const opts = fieldsOf(options)
    const cwd = spelled(opts.cwd) ?? process.cwd()
    const exclude = opts.exclude
    const typed = opts.withFileTypes === true
    const seen = new Set<string>()
    for (const raw of Array.isArray(pattern) ? pattern : [pattern]) {
      const spelling = spelled(raw)
      if (spelling === null) continue
      const absolute = posix.isAbsolute(spelling)
        ? posix.normalize(spelling)
        : posix.join(cwd, spelling)
      const shown = (path: string): string =>
        posix.isAbsolute(spelling) ? path : posix.relative(cwd, path) || '.'
      const parts = absolute.split('/').slice(1)
      const magic = parts.findIndex((part) => GLOB_MAGIC.test(part))
      const base = `/${parts.slice(0, magic === -1 ? parts.length : magic).join('/')}`
      const rest = magic === -1 ? '' : parts.slice(magic).join('/')
      // A `**` that is a whole name, inside braces too, may match at any
      // depth; within a name (`foo**`) it is a `*`.
      const depth = /(^|[/{,])\*\*($|[/},])/.test(rest) ? Infinity : rest.split('/').length
      const skipped = (path: string, entry: unknown): boolean => {
        if (typeof exclude === 'function') return Boolean((exclude as Fn)(typed ? entry : path))
        return Array.isArray(exclude) && exclude.some((ex) => posix.matchesGlob(path, String(ex)))
      }
      let top: Stats
      try {
        top = await this.entryOf(base, true)
      } catch (err) {
        if (!isMissingPath(err)) throw err
        continue
      }
      const baseEntry = {
        name: posix.basename(base),
        parentPath: posix.dirname(base),
        path: posix.dirname(base),
        isFile: () => top.isFile(),
        isDirectory: () => top.isDirectory(),
        isBlockDevice: () => false,
        isCharacterDevice: () => false,
        isSymbolicLink: () => false,
        isFIFO: () => false,
        isSocket: () => false,
      }
      const pending: [string, string, number, unknown][] = [[base, '', 0, baseEntry]]
      for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
        const [path, relative, level, entry] = next
        const named = shown(path)
        if (relative !== '' && skipped(named, entry)) continue
        if (
          (magic === -1 ? relative === '' : posix.matchesGlob(relative, rest)) &&
          !seen.has(named)
        ) {
          seen.add(named)
          yield typed ? entry : named
        }
        const isDirectory = (entry as { isDirectory(): boolean }).isDirectory()
        if (magic === -1 || !isDirectory || level >= depth) continue
        const children = (await routed.readdir(path, { withFileTypes: true })) as unknown as {
          name: string
          isSymbolicLink(): boolean
          isDirectory(): boolean
        }[]
        for (const child of children) {
          const childPath = posix.join(path, child.name)
          pending.push([
            childPath,
            relative === '' ? child.name : `${relative}/${child.name}`,
            child.isSymbolicLink() ? depth : level + 1,
            child,
          ])
        }
      }
    }
  }

  async mkdtemp(prefix: string, options?: Options): Promise<Buffer | string> {
    // A prefix whose names fall outside the mount (`/data` makes
    // `/dataXXXXXX`) is the host's.
    if (!this.mounted(`${prefix}XXXXXX`))
      return this.nativeCall('mkdtemp', prefix, options) as Promise<string>
    // Six characters after the prefix, as node's template has them, drawn
    // again for a name already there.
    for (;;) {
      const path = prefix + tempSuffix()
      try {
        await this.files.mkdir(path)
        return encoded(path, options)
      } catch (err) {
        if (classify(err) !== 'EEXIST') throw fsError(err, 'mkdtemp', path)
      }
    }
  }

  async mkdtempDisposable(prefix: string, options?: Options): Promise<unknown> {
    const path = await this.mkdtemp(prefix, options)
    const remove = (): Promise<void> => routed.rm(String(path), { recursive: true, force: true })
    return { path, remove, [Symbol.asyncDispose]: remove }
  }

  async opendir(path: string, options?: Options): Promise<unknown> {
    try {
      return openedDir(
        path,
        await this.readdir(path, {
          withFileTypes: true,
          recursive: fieldsOf(options).recursive === true,
          encoding: fieldsOf(options).encoding,
        }),
      )
    } catch (err) {
      throw fsError(err, 'opendir', path)
    }
  }

  async realpath(path: string, options?: Options): Promise<Buffer | string> {
    // As realpath(3) walks a path: each name in turn, a link swapped for
    // where it leads, so a `..` after a link climbs from its target.
    const todo = path.split('/')
    let done = '/'
    let hops = 0
    for (let name = todo.shift(); name !== undefined; name = todo.shift()) {
      if (name === '' || name === '.') continue
      if (name === '..') {
        done = posix.dirname(done)
        continue
      }
      const next = posix.join(done, name)
      let st: VFSStat
      try {
        st = await this.files.stat(next, true)
      } catch (err) {
        throw fsError(err, 'realpath', path)
      }
      if (st.isLink === true) {
        if (++hops > MAX_SYMLINK_HOPS) throw refusal('ELOOP', 'realpath', path)
        const target = await this.files.readlink(next)
        if (target.startsWith('/')) done = '/'
        todo.unshift(...target.split('/'))
        continue
      }
      if (!st.isDir && todo.some((rest) => rest !== '')) throw refusal('ENOTDIR', 'realpath', path)
      done = next
    }
    return encoded(done, options)
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
        const name = entryName(row.path)
        out.push(
          typed ? dirent(directory, row, encoded(name, options)) : encoded(prefix + name, options),
        )
        if (recursive && row.isDir && row.isLink !== true) {
          await walk(posix.join(directory, name), `${prefix}${name}/`)
        }
      }
    }
    await walk(path, '')
    return out
  }

  async readlink(path: string, options?: Options): Promise<Buffer | string> {
    return encoded(await this.files.readlink(path), options)
  }

  async rename(src: string, dst: string): Promise<void> {
    // A move between a mount and the host is EXDEV, the kernel's answer
    // for two filesystems and the errno a mover retries as copy + delete.
    if (!this.mounted(src) || !this.mounted(dst)) throw refusal('EXDEV', 'rename', src)
    // The descriptors open on either end follow it (the core sees to it).
    await this.files.rename(src, dst)
  }

  /** Remove a file, the descriptors open on it keeping the bytes it had. */
  private async removeFile(path: string): Promise<void> {
    await this.files.unlink(path)
  }

  async rm(path: string, options?: Options): Promise<void> {
    const force = fieldsOf(options).force === true
    const recursive = fieldsOf(options).recursive === true
    // A mount root is refused however it is spelled (`/data/.`), before
    // the stat a backend may answer for that spelling or not.
    if (this.ws.vfs.isMount(posix.normalize(path))) throw refusal('EBUSY', 'rm', path)
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
    if (this.ws.vfs.isMount(posix.normalize(path))) throw refusal('EBUSY', 'rm', path)
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
        const name = entryName(row.path)
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
    if (this.ws.vfs.isMount(posix.normalize(path))) {
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
    // Writes a descriptor still owes land first (the core sees to it), or
    // landing them at its close would stamp over the times set here.
    await this.files.setattr(path, { atime: stampOf(atime), mtime: stampOf(mtime) })
  }

  async writeFile(path: string, data: unknown, options?: Options): Promise<void> {
    await this.put(path, data, options, 'w')
  }

  /** readFile, writeFile or appendFile given a mounted descriptor or
   * FileHandle: from and at its position, as node's are on a descriptor. */
  async fileCall(name: string, target: unknown, rest: unknown[]): Promise<unknown> {
    if (target instanceof MountedFileHandle && !target.live()) throw ebadf(String(target.fd))
    const fd = target instanceof MountedFileHandle ? target.fd : (target as number)
    if (name === 'readFile') {
      const read = () => this.descriptors.file(fd, true, false).read(-1)
      const bytes = Buffer.from(await this.descriptors.serial(fd, read))
      const encoding = encodingOf(rest[0] as Options)
      return encoding === undefined ? bytes : bytes.toString(encoding)
    }
    await this.fdWrite(fd, bytesOf(rest[0], rest[1] as Options), null)
    return undefined
  }

  /** A mounted path's `FileHandle`, as `fs.promises.open` answers. */
  async open(path: string, flags?: unknown): Promise<MountedFileHandle> {
    try {
      const fd = await this.descriptors.open(path, openFlags(flags))
      return new MountedFileHandle(this, fd, this.descriptors.get(fd))
    } catch (error) {
      throw fsError(error, 'open', path)
    }
  }

  /** A read into `buffer` at `offset`, at `position` or, when null, at the
   * descriptor's own position, advancing it. The caller holds its queue. */
  private async readInto(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ): Promise<number> {
    const desc = this.descriptors.file(fd, true, false)
    const bytes = position === null ? await desc.read(length) : await desc.pread(position, length)
    buffer.set(bytes, offset)
    return bytes.byteLength
  }

  /** A write through a mounted descriptor, in its turn on the descriptor. */
  private fdWrite(fd: number, bytes: Uint8Array, position: number | null): Promise<number> {
    return this.descriptors.serial(fd, async () => {
      const desc = this.descriptors.file(fd, false, true)
      // Linux appends a positioned write on an O_APPEND descriptor,
      // whatever the position, and leaves the position where it was: the
      // core writes an appending handle at its end.
      if (position === null) await desc.write(bytes.slice())
      else await desc.pwrite(position, bytes.slice())
      return bytes.byteLength
    })
  }

  /** A descriptor call on a mounted descriptor, answered with what node's
   * callback gets after its error slot. */
  async descriptorCall(name: string, args: unknown[]): Promise<unknown[]> {
    try {
      const fd = args[0] as number
      const rest = args.slice(1)
      const desc = this.descriptors.get(fd)
      if (desc === undefined) throw ebadf(String(fd))
      switch (name) {
        case 'read': {
          const [buffer, offset, length, position, original] = readArgs(rest)
          const read = () => this.readInto(fd, buffer, offset, length, position)
          return [await this.descriptors.serial(fd, read), original]
        }
        case 'write': {
          const [bytes, position] = writeArgs(rest[0], rest.slice(1))
          return [await this.fdWrite(fd, bytes, position), rest[0]]
        }
        case 'readv':
          return await this.descriptors.serial(fd, async () => {
            const buffers = rest[0] as Uint8Array[]
            let at = positionOf(rest[1])
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
          const position = positionOf(rest[1])
          const joined = Buffer.concat(buffers.map((b) => bytesOf(b, null)))
          return [await this.fdWrite(fd, joined, position), buffers]
        }
        case 'fstat': {
          const row = await this.files.fstat(desc.fd)
          return [this.statsOf(desc.inode, row, rest[0] as Options, this.files.unlinked(desc.fd))]
        }
        case 'ftruncate':
          if (!desc.mode.writable) throw einval(desc.path)
          await this.descriptors.serial(fd, () =>
            this.descriptors.file(fd, false, true).truncate(Math.max(0, Number(rest[0] ?? 0))),
          )
          return []
        case 'fsync':
        case 'fdatasync':
          await this.descriptors.serial(fd, () => desc.land())
          return []
        case 'close':
          await this.descriptors.close(fd)
          return []
        case 'fchmod':
          await this.chmod(desc.path, rest[0] as number)
          return []
        case 'fchown':
          await this.chown(desc.path, rest[0] as number, rest[1] as number)
          return []
        case 'futimes':
          await this.utimes(desc.path, rest[0], rest[1])
          return []
        default:
          throw new TypeError(`mirage.patchNodeFs: ${name} is not a descriptor call`)
      }
    } catch (error) {
      throw fsError(error, name)
    }
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
    // An open, a write and a close through the core, as node's own do, so
    // the descriptors open on the file see it and an exclusive flag refuses
    // a name that is there.
    const fd = await this.files.open(path, openMode(openFlags(flag), constants))
    try {
      await this.files.pwrite(fd, 0, bytes)
    } finally {
      await this.files.close(fd)
    }
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
    // A promise, or for `glob` the iterator node's answers with.
    const route = (args: unknown[]): unknown =>
      (host[name] as (...a: unknown[]) => unknown).call(host, ...spellPaths(name, args))
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
      const answered = route(rest)
      // `glob`'s callback takes every name at once; `exists` is the one
      // callback without an error slot.
      ;(name === 'glob'
        ? collected(answered as AsyncIterable<unknown>)
        : (answered as Promise<unknown>)
      ).then(
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
      // any path whose stat fails; the root of a mount the session sees
      // is the one name it knows is there without asking, unless a `..`
      // in the spelling walks through a name it has not checked.
      if (name === 'exists') return !path.split('/').includes('..') && ws.vfs.isMount(path)
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
      host.open(path, rest[1]).then((handle) => [handle.fd]),
      done as Fn,
    )
    return undefined
  })
  swap(fs, 'openSync', (original) => (...args) => {
    const path = mountedIn('open', args)
    if (path !== null) throw syncRefusal('openSync', path)
    return original(...args)
  })

  for (const name of DESCRIPTOR_CALLS) {
    swap(fs, name, (original) => (...args) => {
      if (host.descriptors.get(args[0]) === undefined) return original(...args)
      const done = args.at(-1)
      // fs.close is the one whose callback node lets a caller leave out;
      // node throws an unhandled close error on the next turn.
      const callback: Fn =
        typeof done === 'function'
          ? (done as Fn)
          : (err: unknown) => {
              if (err !== null)
                process.nextTick(() => {
                  throw err instanceof Error ? err : new Error('close failed', { cause: err })
                })
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
