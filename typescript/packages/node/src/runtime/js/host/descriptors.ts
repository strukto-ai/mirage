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
/**
 * One descriptor `open` handed out for a mounted path. `path` is the path
 * it names now (a rename through the patch moves it); `handle` is null for
 * a directory, which a descriptor may name but not read; `kept` holds the
 * bytes its file had once its name was removed or replaced, which it reads
 * from then on and never lands on.
 */
export interface Descriptor {
  path: string
  readonly mode: OpenMode
  handle: FileHandle | null
  kept: Uint8Array | null
}

/** Read `size` bytes at `offset` without moving the handle's position,
 * fetching what the handle lacks first; the caller holds the descriptor's
 * queue, so nothing else moves the position meanwhile. */
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
 * until a `close` or an `fsync`. The calls on one descriptor run one at a
 * time (`serial`), so a sync never settles writes made while it was out
 * and a positioned read never moves another call's position. A descriptor
 * follows its file through a rename made through the patch, and keeps the
 * bytes it had once one removes or replaces its name.
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
    const mode = openMode(flags)
    const row = await this.files.statOrNull(path, (flags & O_NOFOLLOW) !== 0)
    if (row?.isLink === true) throw eloop(path)
    if ((flags & O_DIRECTORY) !== 0 && row?.isDir !== true) {
      throw row === null ? enoent(path) : enotdir(path)
    }
    const desc: Descriptor = { path, mode, handle: null, kept: null }
    if (row?.isDir !== true || mode.writable || mode.create) {
      const opened = await applyOpen(this.files, path, mode)
      desc.handle = FileHandle.opened(
        path,
        opened === null ? null : this.fetch(desc, mode.writable),
        { size: opened?.size ?? 0, writable: mode.writable, append: mode.append },
      )
    }
    const fd = (this.native.openSync as (p: string, f: string) => number)(devNull, 'r')
    this.table.set(fd, desc)
    return fd
  }

  /** A descriptor's ranged read: what it kept once its name went, else
   * what is at its path now. */
  private fetch(desc: Descriptor, raw: boolean): FileFetch {
    return (offset, size) => {
      if (desc.kept !== null) {
        return Promise.resolve(desc.kept.slice(offset, size === null ? undefined : offset + size))
      }
      return this.files.read(desc.path, size === null ? { raw } : { offset, size, raw })
    }
  }

  /** Land a descriptor's writes on the mount; one whose name went keeps
   * them, as writes to an unlinked file stay with it. */
  async land(desc: Descriptor): Promise<void> {
    const handle = desc.handle
    if (handle === null || desc.kept !== null) return
    const steps = handle.flushPlan()
    if (steps.length === 0) return
    await this.files.flush(desc.path, steps)
    handle.settle(this.fetch(desc, true))
  }

  /** Land the writes of every descriptor open on `path`, which a change of
   * its times must come after. */
  async landPath(path: string): Promise<void> {
    for (const [fd, desc] of this.table) {
      if (desc.path === path) await this.serial(fd, () => this.land(desc))
    }
  }

  /** Follow a rename: a descriptor on `old` or under it names the same
   * file at `next` now. */
  moved(old: string, next: string): void {
    const under = `${old.replace(/\/+$/, '')}/`
    for (const desc of this.table.values()) {
      if (desc.kept === null && (desc.path === old || desc.path.startsWith(under))) {
        desc.path = next + desc.path.slice(old.length)
      }
    }
  }

  /** Read what the descriptors open on `path` (or under it) need before
   * its name is removed or replaced; `keep` them once it has gone. */
  async hold(path: string, under = false): Promise<[Descriptor, Uint8Array][]> {
    const prefix = `${path.replace(/\/+$/, '')}/`
    const held: [Descriptor, Uint8Array][] = []
    for (const desc of this.table.values()) {
      const named = desc.path === path || (under && desc.path.startsWith(prefix))
      if (!named || desc.kept !== null || desc.handle === null) continue
      // A descriptor that cannot read needs nothing kept, and a read a
      // policy refuses must not refuse the removal it allows.
      let data: Uint8Array = new Uint8Array()
      if (desc.mode.readable) {
        try {
          data = await this.files.read(desc.path, { raw: desc.mode.writable })
        } catch (err) {
          console.warn(`host: keeping ${desc.path} before it goes failed`, err)
        }
      }
      held.push([desc, data])
    }
    return held
  }

  /** Detach the descriptors `hold` read for, now their name went. */
  keep(held: [Descriptor, Uint8Array][]): void {
    for (const [desc, data] of held) desc.kept = data
  }

  /** Land a descriptor's writes and give its number back. */
  close(fd: number): Promise<void> {
    return this.serial(fd, async () => {
      const desc = this.table.get(fd)
      if (desc === undefined) throw ebadf(String(fd))
      this.table.delete(fd)
      try {
        await this.land(desc)
      } finally {
        ;(this.native.closeSync as (f: number) => void)(fd)
      }
    })
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
