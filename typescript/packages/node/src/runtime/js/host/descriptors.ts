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

import { constants } from 'node:fs'
import { devNull } from 'node:os'
import { ebadf, eisdir, eloop, enoent, enotdir } from '@struktoai/mirage-core/errors/fs'
import { Descriptor, type RuntimeFiles } from '@struktoai/mirage-core/runtime/files'
import { openMode } from '@struktoai/mirage-core/runtime/handles/mode'

const { O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_EXCL, O_TRUNC, O_APPEND } = constants
const { O_NOFOLLOW, O_DIRECTORY } = constants

// node's string flags as open(2) flags, the synchronous spellings read as
// their plain ones: a mount has no page cache for them to bypass.
const STRING_FLAGS: Readonly<Record<string, number>> = {
  r: O_RDONLY,
  rs: O_RDONLY,
  sr: O_RDONLY,
  'r+': O_RDWR,
  'rs+': O_RDWR,
  'sr+': O_RDWR,
  w: O_TRUNC | O_CREAT | O_WRONLY,
  wx: O_TRUNC | O_CREAT | O_WRONLY | O_EXCL,
  xw: O_TRUNC | O_CREAT | O_WRONLY | O_EXCL,
  'w+': O_TRUNC | O_CREAT | O_RDWR,
  'wx+': O_TRUNC | O_CREAT | O_RDWR | O_EXCL,
  'xw+': O_TRUNC | O_CREAT | O_RDWR | O_EXCL,
  a: O_APPEND | O_CREAT | O_WRONLY,
  ax: O_APPEND | O_CREAT | O_WRONLY | O_EXCL,
  xa: O_APPEND | O_CREAT | O_WRONLY | O_EXCL,
  as: O_APPEND | O_CREAT | O_WRONLY,
  sa: O_APPEND | O_CREAT | O_WRONLY,
  'a+': O_APPEND | O_CREAT | O_RDWR,
  'ax+': O_APPEND | O_CREAT | O_RDWR | O_EXCL,
  'xa+': O_APPEND | O_CREAT | O_RDWR | O_EXCL,
  'as+': O_APPEND | O_CREAT | O_RDWR,
  'sa+': O_APPEND | O_CREAT | O_RDWR,
}

/** node's `flags` argument as open(2) flags; node's default is `'r'`. */
export function openFlags(flags: unknown): number {
  if (typeof flags === 'number') return flags
  if (flags === undefined || flags === null) return O_RDONLY
  const known = typeof flags === 'string' ? STRING_FLAGS[flags] : undefined
  if (known === undefined) {
    const shown = typeof flags === 'string' ? flags : typeof flags
    throw Object.assign(new TypeError(`The value "${shown}" is invalid for option "flags"`), {
      code: 'ERR_INVALID_ARG_VALUE',
    })
  }
  return known
}

/**
 * The descriptors `open` hands out for mounted paths, by number: the
 * twin of python's `host/descriptors.Descriptors`.
 *
 * Each number is a real descriptor on the null device, held open as long
 * as the mounted one is, so it never collides with a file the process
 * opens meanwhile; the descriptor calls that could reach the device with
 * it (fchmod, fchown, futimes) are routed too. The calls on one
 * descriptor run one at a time (`serial`), so a sync never settles writes
 * made while it was out and a positioned read never moves another call's
 * position. What a file holds and what a descriptor wrote are the core's
 * (`RuntimeFiles.open`), which lands the writes at a close or an `fsync`,
 * follows a rename and keeps the file a removal or a replacement took the
 * name of, as POSIX keeps an open file on its inode.
 */
export class Descriptors {
  private readonly table = new Map<number, Descriptor>()
  private readonly queues = new Map<number, Promise<void>>()

  constructor(
    private readonly files: RuntimeFiles,
    private readonly native: Record<string, unknown>,
  ) {}

  /** The mounted descriptor `fd` is, else undefined. */
  get(fd: unknown): Descriptor | undefined {
    return typeof fd === 'number' ? this.table.get(fd) : undefined
  }

  /** Run `fn` after every call already queued on `fd`. */
  serial<T>(fd: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(fd) ?? Promise.resolve()
    const run = prev.then(fn)
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    this.queues.set(fd, tail)
    void tail.then(() => {
      if (this.queues.get(fd) === tail) this.queues.delete(fd)
    })
    return run
  }

  /** Open a mounted path by open(2) flags and number the result. */
  async open(path: string, flags: number): Promise<number> {
    const mode = { ...openMode(flags, constants), directory: true }
    const row = await this.files.statOrNull(path, (flags & O_NOFOLLOW) !== 0)
    if (row?.isLink === true) throw eloop(path)
    if ((flags & O_DIRECTORY) !== 0 && row?.isDir !== true) {
      throw row === null ? enoent(path) : enotdir(path)
    }
    const desc = new Descriptor(
      this.files,
      await this.files.open(path, mode),
      mode,
      path,
      row?.isDir === true,
    )
    const fd = (this.native.openSync as (p: string, f: string) => number)(devNull, 'r')
    this.table.set(fd, desc)
    return fd
  }

  /** Land a descriptor's writes and give its number back. */
  close(fd: number): Promise<void> {
    return this.serial(fd, async () => {
      const desc = this.table.get(fd)
      if (desc === undefined) throw ebadf(String(fd))
      this.table.delete(fd)
      try {
        await desc.close()
      } finally {
        ;(this.native.closeSync as (f: number) => void)(fd)
      }
    })
  }

  /** The descriptor a read or a write through `fd` uses. */
  file(fd: number, wantRead: boolean, wantWrite: boolean): Descriptor {
    const desc = this.table.get(fd)
    if (desc === undefined) throw ebadf(String(fd))
    if (desc.directory) throw eisdir(desc.path)
    if ((wantRead && !desc.mode.readable) || (wantWrite && !desc.mode.writable)) {
      throw ebadf(desc.path)
    }
    return desc
  }
}
