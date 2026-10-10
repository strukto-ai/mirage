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
import type { RuntimeFiles } from '@struktoai/mirage-core/runtime/files'
import { FileHandle } from '@struktoai/mirage-core/runtime/handles/file_handle'
import type { OpenMode } from '@struktoai/mirage-core/runtime/handles/mode'
import type { FileFetch } from '@struktoai/mirage-core/runtime/handles/types'
import { applyOpen } from '@struktoai/mirage-core/runtime/open'

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

/** What open(2) flags say about a handle, in the mode vocabulary. Mirrors
 * python's `host/descriptors.open_mode`. */
export function openMode(flags: number): OpenMode {
  const access = flags & (O_WRONLY | O_RDWR)
  const writable = access === O_WRONLY || access === O_RDWR
  const create = (flags & O_CREAT) !== 0
  return {
    readable: access === O_RDONLY || access === O_RDWR,
    writable,
    truncate: writable && (flags & O_TRUNC) !== 0,
    append: (flags & O_APPEND) !== 0,
    create,
    exclusive: create && (flags & O_EXCL) !== 0,
    binary: true,
  }
}

/** One descriptor `open` handed out for a mounted path; `handle` is null
 * for a directory, which a descriptor may name but not read. */
export interface Descriptor {
  readonly path: string
  readonly mode: OpenMode
  readonly handle: FileHandle | null
}

/** Read `size` bytes at `offset` without moving the handle's position,
 * fetching what the handle lacks first. */
export async function readAt(
  handle: FileHandle,
  offset: number,
  size: number,
): Promise<Uint8Array> {
  const pos = handle.pos
  handle.pos = offset
  try {
    while (handle.lacks(size)) await handle.fill(size)
    return handle.pread(offset, size)
  } finally {
    handle.pos = pos
  }
}

/** Read up to `size` bytes at the position, advancing it. */
export async function readOn(handle: FileHandle, size: number): Promise<Uint8Array> {
  while (handle.lacks(size)) await handle.fill(size)
  return handle.read(size)
}

/**
 * The descriptors `open` hands out for mounted paths, by number: the
 * twin of python's `host/descriptors.Descriptors`.
 *
 * Each number is a real descriptor on the null device, held open as long
 * as the mounted one is, so it never collides with a file the process
 * opens meanwhile; the descriptor calls that could reach the device with
 * it (fchmod, fchown, futimes) are routed too. Writes stay in the handle
 * until a `close` or an `fsync`.
 */
export class Descriptors {
  private readonly table = new Map<number, Descriptor>()

  constructor(
    private readonly files: RuntimeFiles,
    private readonly native: Record<string, unknown>,
  ) {}

  /** The mounted descriptor `fd` is, else undefined. */
  get(fd: unknown): Descriptor | undefined {
    return typeof fd === 'number' ? this.table.get(fd) : undefined
  }

  /** Open a mounted path by open(2) flags and number the result. */
  async open(path: string, flags: number): Promise<number> {
    const mode = openMode(flags)
    const row = await this.files.statOrNull(path, (flags & O_NOFOLLOW) !== 0)
    if (row?.isLink === true) throw eloop(path)
    if ((flags & O_DIRECTORY) !== 0 && row?.isDir !== true) {
      throw row === null ? enoent(path) : enotdir(path)
    }
    let handle: FileHandle | null = null
    if (row?.isDir !== true || mode.writable || mode.create) {
      const opened = await applyOpen(this.files, path, mode)
      handle = FileHandle.opened(path, opened === null ? null : this.fetch(path, mode.writable), {
        size: opened?.size ?? 0,
        writable: mode.writable,
        append: mode.append,
      })
    }
    const fd = (this.native.openSync as (p: string, f: string) => number)(devNull, 'r')
    this.table.set(fd, { path, mode, handle })
    return fd
  }

  private fetch(path: string, raw: boolean): FileFetch {
    return (offset, size) => this.files.read(path, size === null ? { raw } : { offset, size, raw })
  }

  /** Land a descriptor's writes on the mount. */
  async land(desc: Descriptor): Promise<void> {
    const handle = desc.handle
    if (handle === null) return
    const steps = handle.flushPlan()
    if (steps.length === 0) return
    await this.files.flush(desc.path, steps)
    handle.settle(this.fetch(desc.path, true))
  }

  /** Land a descriptor's writes and give its number back. */
  async close(fd: number): Promise<void> {
    const desc = this.table.get(fd)
    if (desc === undefined) throw ebadf(String(fd))
    this.table.delete(fd)
    try {
      await this.land(desc)
    } finally {
      ;(this.native.closeSync as (f: number) => void)(fd)
    }
  }

  /** The handle a read or a write through `fd` uses. */
  file(fd: number, wantRead: boolean, wantWrite: boolean): FileHandle {
    const desc = this.table.get(fd)
    if (desc === undefined) throw ebadf(String(fd))
    if (desc.handle === null) throw eisdir(desc.path)
    if ((wantRead && !desc.mode.readable) || (wantWrite && !desc.mode.writable)) {
      throw ebadf(desc.path)
    }
    return desc.handle
  }
}
