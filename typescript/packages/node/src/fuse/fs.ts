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
import type { OpRecord } from '@struktoai/mirage-core/observe/record'
import type { Ops } from '@struktoai/mirage-core/ops/ops'
import type { Session } from '@struktoai/mirage-core/workspace/session/session'
import { MountCore } from '../mount/core.ts'
import type { MountAttrs } from '../mount/types.ts'
import { classifyErrno } from '../mount/errors.ts'

export type { MountAttrs }

type Cb<T> = (code: number, result?: T) => void

export interface MirageFSOptions {
  rootPrefix?: string
  /**
   * Bind every FUSE op to this session's mount grants. The kernel-tier
   * primitive: bind-mount the tree into a container and the narrowing
   * travels with it. Enforcement happens inside dispatch/Ops via the
   * session context, so binding at the op entry point is sufficient.
   */
  session?: Session
}

/**
 * libfuse adapter over MountCore.
 *
 * Owns exactly the FUSE-specific concerns: the `@zkochan/fuse-native`
 * callback signatures and the translation of mirage-native errors into
 * negative errno codes. All filesystem semantics live in MountCore, so a
 * non-FUSE adapter can reuse them unchanged. Mirrors Python's `MirageFS`.
 */
/**
 * The mount core's errno, negated the way `@zkochan/fuse-native`
 * callbacks report failure. One line and one caller, so it lives beside
 * that caller rather than in a module of its own.
 */
function classifyError(err: unknown): number {
  return -classifyErrno(err)
}

export class MirageFS {
  readonly core: MountCore

  constructor(ops: Ops, options: MirageFSOptions = {}) {
    this.core = new MountCore(ops, options)
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
    // callback starts inherits the context, so dispatch/Ops enforce the
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

  private getattr(path: string, cb: Cb<MountAttrs>): void {
    void this.core.getattr(path).then(
      (attr) => {
        cb(0, attr)
      },
      (err: unknown) => {
        cb(classifyError(err))
      },
    )
  }

  private fgetattr(path: string, fd: number, cb: Cb<MountAttrs>): void {
    void this.core.fgetattr(path, fd).then(
      (attr) => {
        cb(0, attr)
      },
      (err: unknown) => {
        cb(classifyError(err))
      },
    )
  }

  private readdir(path: string, cb: Cb<string[]>): void {
    void this.core.readdir(path).then(
      (names) => {
        cb(0, names)
      },
      (err: unknown) => {
        cb(classifyError(err))
      },
    )
  }

  private read(
    path: string,
    fd: number,
    buf: Buffer,
    len: number,
    pos: number,
    cb: (result: number) => void,
  ): void {
    void this.core.read(path, fd, pos, len).then(
      (slice) => {
        buf.set(slice, 0)
        cb(slice.byteLength)
      },
      (err: unknown) => {
        // A policy refusal must surface as EACCES, never read as an
        // empty file. Any other failed read reports 0 bytes (EOF): the
        // kernel has already accepted the open, and short-reading is how
        // FUSE signals "nothing more here".
        if ((err as { code?: string }).code === 'EACCES') {
          cb(classifyError(err))
          return
        }
        cb(0)
      },
    )
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
    void this.core.write(path, fd, data, pos).then(
      () => {
        cb(len)
      },
      (err: unknown) => {
        // Same EACCES rule as read: a policy refusal is an errno, any
        // other failure reports 0 bytes written.
        if ((err as { code?: string }).code === 'EACCES') {
          cb(classifyError(err))
          return
        }
        cb(0)
      },
    )
  }

  private create(path: string, _mode: number, cb: Cb<number>): void {
    void this.core.create(path).then(
      (fh) => {
        cb(0, fh)
      },
      (err: unknown) => {
        cb(classifyError(err))
      },
    )
  }

  private mkdir(path: string, _mode: number, cb: (code: number) => void): void {
    void this.core.mkdir(path).then(
      () => {
        cb(0)
      },
      (err: unknown) => {
        cb(classifyError(err))
      },
    )
  }

  private readlink(path: string, cb: Cb<string>): void {
    try {
      cb(0, this.core.readlink(path))
    } catch (err) {
      cb(classifyError(err))
    }
  }

  private symlink(src: string, dest: string, cb: (code: number) => void): void {
    void this.core.symlink(src, dest).then(
      () => {
        cb(0)
      },
      (err: unknown) => {
        cb(classifyError(err))
      },
    )
  }

  private unlink(path: string, cb: (code: number) => void): void {
    void this.core.unlink(path).then(
      () => {
        cb(0)
      },
      (err: unknown) => {
        cb(classifyError(err))
      },
    )
  }

  private rename(src: string, dst: string, cb: (code: number) => void): void {
    void this.core.rename(src, dst).then(
      () => {
        cb(0)
      },
      (err: unknown) => {
        cb(classifyError(err))
      },
    )
  }

  private rmdir(path: string, cb: (code: number) => void): void {
    void this.core.rmdir(path).then(
      () => {
        cb(0)
      },
      (err: unknown) => {
        cb(classifyError(err))
      },
    )
  }

  private truncate(path: string, size: number, cb: (code: number) => void): void {
    void this.core.truncate(path, size).then(
      () => {
        cb(0)
      },
      (err: unknown) => {
        cb(classifyError(err))
      },
    )
  }

  private statfs(_path: string, cb: Cb<Record<string, number>>): void {
    cb(0, this.core.statfs())
  }

  // chmod / chown / utimens / access are no-ops for the filesystem but must
  // validate path existence — callers like `touch`/`chmod` on a missing file
  // should fail with ENOENT, not silently succeed.

  private chmod(path: string, _mode: number, cb: (code: number) => void): void {
    this.validate(path, cb)
  }

  private chown(path: string, _uid: number, _gid: number, cb: (code: number) => void): void {
    this.validate(path, cb)
  }

  private utimens(path: string, _atime: Date, _mtime: Date, cb: (code: number) => void): void {
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
    _flags: number,
    cb: (code: number) => void,
  ): void {
    this.validate(path, (code) => {
      if (code !== 0) {
        cb(code)
        return
      }
      this.core.setxattr(path, name, value)
      cb(0)
    })
  }

  private getxattr(
    path: string,
    name: string,
    _position: number,
    cb: (code: number, value?: Buffer) => void,
  ): void {
    this.validate(path, (code) => {
      if (code !== 0) {
        cb(code)
        return
      }
      // A missing value tells fuse-native to report ENOATTR/ENODATA.
      cb(0, this.core.getxattr(path, name))
    })
  }

  private listxattr(path: string, cb: (code: number, list?: string[]) => void): void {
    this.validate(path, (code) => {
      if (code !== 0) {
        cb(code)
        return
      }
      cb(0, this.core.listxattr(path))
    })
  }

  private removexattr(path: string, name: string, cb: (code: number) => void): void {
    this.validate(path, (code) => {
      if (code !== 0) {
        cb(code)
        return
      }
      this.core.removexattr(path, name)
      cb(0)
    })
  }

  private validate(path: string, cb: (code: number) => void): void {
    // getattr's callback returns 0 on success and a negative errno on failure
    // (FUSE convention). Pass the code straight through so missing paths
    // surface as ENOENT instead of silently succeeding.
    this.getattr(path, (code) => {
      cb(code)
    })
  }

  private open(path: string, _flags: number, cb: Cb<number>): void {
    void this.core.open(path).then(
      (fh) => {
        cb(0, fh)
      },
      (err: unknown) => {
        cb(classifyError(err))
      },
    )
  }

  private release(_path: string, fd: number, cb: (code: number) => void): void {
    void this.core.release(fd).then(
      () => {
        cb(0)
      },
      (err: unknown) => {
        cb(classifyError(err))
      },
    )
  }

  private flush(path: string, fd: number, cb: (code: number) => void): void {
    void this.core.flush(path, fd).then(
      () => {
        cb(0)
      },
      (err: unknown) => {
        cb(classifyError(err))
      },
    )
  }

  private fsync(path: string, _datasync: number, fd: number, cb: (code: number) => void): void {
    this.flush(path, fd, cb)
  }
}
