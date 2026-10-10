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

import { runWithSession } from '@struktoai/mirage-core/context/session_context'
import { classify } from '@struktoai/mirage-core/errors/index'
import type { OpRecord } from '@struktoai/mirage-core/observe/record'
import type { Files } from '@struktoai/mirage-core/workspace/files'
import type { SessionState } from '@struktoai/mirage-core/workspace/session/session'
import { type FuseAttr, MountCore } from './core.ts'
import { classifyError } from './errors.ts'

// setxattr(2)'s flags as the kernel hands them over: linux numbers
// XATTR_CREATE 1 and XATTR_REPLACE 2, macOS 2 and 4 (its 1 is
// XATTR_NOFOLLOW, which the kernel has already applied). Mirrors the
// python adapter.
const DARWIN = process.platform === 'darwin'
export const XATTR_CREATE = DARWIN ? 0x2 : 0x1
export const XATTR_REPLACE = DARWIN ? 0x4 : 0x2

export type { FuseAttr }

type Cb<T> = (code: number, result?: T) => void

export interface MirageFSOptions {
  rootPrefix?: string
  /**
   * Bind every FUSE op to this session's mount grants. The kernel-tier
   * primitive: bind-mount the tree into a container and the narrowing
   * travels with it. Enforcement happens inside dispatch/Files via the
   * session context, so binding at the op entry point is sufficient.
   */
  session?: SessionState
}

/**
 * libfuse adapter over MountCore.
 *
 * Owns exactly the FUSE-specific concerns: the `@zkochan/fuse-native`
 * callback signatures and the translation of mirage-native errors into
 * negative errno codes. All filesystem semantics live in MountCore, so a
 * non-FUSE adapter can reuse them unchanged. Mirrors Python's `MirageFS`.
 */
export class MirageFS {
  readonly core: MountCore

  constructor(files: Files, options: MirageFSOptions = {}) {
    this.core = new MountCore(files, options)
  }

  /** Drain and return accumulated op records (mirrors Python's drainOps). */
  drainOps(): OpRecord[] {
    return this.core.drainOps()
  }

  // ── FUSE op surface (mirrors mfusepy Operations) ─────────────────

  ops(): Record<string, unknown> {
    const table: Record<string, (...args: never[]) => void> = {
      readdir: this.readdir.bind(this),
      getattr: this.getattr.bind(this),
      fgetattr: this.fgetattr.bind(this),
      open: this.open.bind(this),
      read: this.read.bind(this),
      write: this.write.bind(this),
      create: this.create.bind(this),
      readlink: this.readlink.bind(this),
      symlink: this.symlink.bind(this),
      unlink: this.unlink.bind(this),
      mkdir: this.mkdir.bind(this),
      rmdir: this.rmdir.bind(this),
      rename: this.rename.bind(this),
      release: this.release.bind(this),
      truncate: this.truncate.bind(this),
      flush: this.flush.bind(this),
      fsync: this.fsync.bind(this),
      utimens: this.utimens.bind(this),
      chmod: this.chmod.bind(this),
      chown: this.chown.bind(this),
      access: this.access.bind(this),
      setxattr: this.setxattr.bind(this),
      getxattr: this.getxattr.bind(this),
      listxattr: this.listxattr.bind(this),
      removexattr: this.removexattr.bind(this),
      statfs: this.statfs.bind(this),
    }
    const session = this.core.session
    if (session === null) return table
    // A session-bound tree enters the session context before every op,
    // mirroring Python's MountCore session binding: the async work each
    // callback starts inherits the context, so dispatch/Files enforce the
    // session's mount grants for kernel-originated I/O too.
    const bound: Record<string, unknown> = {}
    for (const [name, fn] of Object.entries(table)) {
      bound[name] = (...args: never[]) => {
        void runWithSession(session, () => {
          fn(...args)
          return Promise.resolve()
        })
      }
    }
    return bound
  }

  private getattr(path: string, cb: Cb<FuseAttr>): void {
    this.respond(this.core.getattr(path), cb)
  }

  private fgetattr(path: string, fd: number, cb: Cb<FuseAttr>): void {
    this.respond(this.core.fgetattr(path, fd), cb)
  }

  private readdir(path: string, cb: Cb<string[]>): void {
    this.respond(this.core.readdir(path), cb)
  }

  private read(
    path: string,
    fd: number,
    buf: Buffer,
    len: number,
    pos: number,
    cb: (result: number) => void,
  ): void {
    this.respond(this.core.read(path, fd, pos, len), cb, (slice) => {
      buf.set(slice, 0)
      cb(slice.byteLength)
    })
  }

  private write(
    path: string,
    fd: number,
    buf: Buffer,
    len: number,
    pos: number,
    cb: (result: number) => void,
  ): void {
    const data = new Uint8Array(buf.subarray(0, len))
    this.respond(this.core.write(path, fd, data, pos), cb, () => {
      cb(len)
    })
  }

  private respond<T>(
    pending: Promise<T>,
    cb: Cb<T>,
    done = (value: T): void => {
      if (value === undefined) cb(0)
      else cb(0, value)
    },
  ): void {
    void pending.then(done, (err: unknown) => {
      cb(classifyError(err))
    })
  }

  private create(path: string, _mode: number, cb: Cb<number>): void {
    this.respond(this.core.create(path), cb)
  }

  private mkdir(path: string, _mode: number, cb: (code: number) => void): void {
    this.respond(this.core.mkdir(path), cb)
  }

  private readlink(path: string, cb: Cb<string>): void {
    this.respond(this.core.readlink(path), cb)
  }

  private symlink(src: string, dest: string, cb: (code: number) => void): void {
    this.respond(this.core.symlink(src, dest), cb)
  }

  private unlink(path: string, cb: (code: number) => void): void {
    this.respond(this.core.unlink(path), cb)
  }

  private rename(src: string, dst: string, cb: (code: number) => void): void {
    this.respond(this.core.rename(src, dst), cb)
  }

  private rmdir(path: string, cb: (code: number) => void): void {
    this.respond(this.core.rmdir(path), cb)
  }

  private truncate(path: string, size: number, cb: (code: number) => void): void {
    this.respond(this.core.truncate(path, size), cb)
  }

  private statfs(_path: string, cb: Cb<Record<string, number>>): void {
    cb(0, this.core.statfs())
  }

  private chmod(path: string, mode: number, cb: (code: number) => void): void {
    this.respond(this.core.setattr(path, mode), cb)
  }

  // -1 leaves an id as it is (chown(2)); fuse-native hands it over unsigned.
  private chown(path: string, uid: number, gid: number, cb: (code: number) => void): void {
    const keptUid = uid === -1 || uid === 0xffffffff ? null : uid
    const keptGid = gid === -1 || gid === 0xffffffff ? null : gid
    this.respond(this.core.setattr(path, null, keptUid, keptGid), cb)
  }

  // Accepted, not stored: libfuse marks "now" and "leave it" in the
  // nanosecond field, which fuse-native folds into milliseconds, and it
  // passes the access time in both slots. utimens and access only check
  // that the path is there.
  private utimens(path: string, _atime: number, _mtime: number, cb: (code: number) => void): void {
    this.validate(path, cb)
  }

  private access(path: string, _amode: number, cb: (code: number) => void): void {
    this.validate(path, cb)
  }

  private setxattr(
    path: string,
    name: string,
    value: Buffer,
    _position: number,
    flags: number,
    cb: (code: number) => void,
  ): void {
    const opts = {
      create: (flags & XATTR_CREATE) !== 0,
      replace: (flags & XATTR_REPLACE) !== 0,
    }
    this.respond(this.core.setxattr(path, name, value, opts), cb)
  }

  private getxattr(
    path: string,
    name: string,
    _position: number,
    cb: (code: number, value?: Buffer) => void,
  ): void {
    void this.core.getxattr(path, name).then(
      (value) => {
        cb(0, Buffer.from(value))
      },
      (err: unknown) => {
        // No value is how fuse-native is told to report ENOATTR (macOS)
        // or ENODATA (linux) for an attribute that is not set.
        if (classify(err) === 'NO_XATTR') cb(0)
        else cb(classifyError(err))
      },
    )
  }

  private listxattr(path: string, cb: (code: number, list?: string[]) => void): void {
    this.respond(this.core.listxattr(path), cb)
  }

  private removexattr(path: string, name: string, cb: (code: number) => void): void {
    this.respond(this.core.removexattr(path, name), cb)
  }

  private validate(path: string, cb: (code: number) => void): void {
    // getattr's callback returns 0 on success and a negative errno on failure
    // (FUSE convention). Pass the code straight through so missing paths
    // surface as ENOENT instead of silently succeeding.
    this.getattr(path, (code) => {
      cb(code)
    })
  }

  private open(path: string, flags: number, cb: Cb<number>): void {
    this.respond(this.core.open(path, flags), cb)
  }

  private release(_path: string, fd: number, cb: (code: number) => void): void {
    this.respond(this.core.release(fd), cb)
  }

  private flush(path: string, fd: number, cb: (code: number) => void): void {
    this.respond(this.core.flush(path, fd), cb)
  }

  private fsync(path: string, _datasync: number, fd: number, cb: (code: number) => void): void {
    this.flush(path, fd, cb)
  }
}
