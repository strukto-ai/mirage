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
import { walkSpelling } from '@struktoai/mirage-core/commands/builtin/utils/paths'
import { ebadf, eisdir, eloop, enoent, enotdir } from '@struktoai/mirage-core/errors/fs'
import type { RuntimeFiles } from '@struktoai/mirage-core/runtime/files'
import { FileHandle } from '@struktoai/mirage-core/runtime/handles/file_handle'
import type { OpenMode } from '@struktoai/mirage-core/runtime/handles/mode'
import type { FileFetch, Kept } from '@struktoai/mirage-core/runtime/handles/types'
import { applyOpen } from '@struktoai/mirage-core/runtime/open'
import { PathSpec } from '@struktoai/mirage-core/types'
import { CycleError, resolvePath } from '@struktoai/mirage-core/utils/path'
import type { NamespaceLinks } from '@struktoai/mirage-core/view/types'

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

/**
 * One descriptor `open` handed out for a mounted path. `path` is the path
 * it names now (a rename through the patch moves it); `handle` is null for
 * a directory, which a descriptor may name but not read; `kept` is its file
 * once its name was removed or replaced, which it reads and lands on from
 * then on; `opened` is the path it was opened at, which its inode number
 * comes from however the file is renamed since.
 */
export interface Descriptor {
  path: string
  readonly mode: OpenMode
  handle: FileHandle | null
  kept: Kept | null
  opened: string
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
    // The namespace's links, which a walk follows; null while it keeps none.
    private readonly links: NamespaceLinks | null,
  ) {}

  /** The path an op on `path` lands on, as the dispatcher walks it: a link
   * in front of a dot followed before the climb, the dots resolved, and the
   * final link followed too when `follow` (a rename or a removal acts on
   * the name itself). One file reads as one path whichever spelling reached
   * it, which is how a rename or an unlink finds the descriptors open on
   * it. Mirrors python's Descriptors.walked. */
  walked(path: string, follow = true): string {
    const spec = PathSpec.fromStrPath(path, undefined, '/')
    const links = this.links
    if (links === null) return spec.virtual
    const resolve = (virtual: string): string => links.follow(virtual)
    try {
      const spelled = walkSpelling(spec, resolve)
      const cut = spelled.lastIndexOf('/')
      const name = spelled.slice(cut + 1)
      if (follow || name === '' || name === '.' || name === '..') {
        return resolvePath(resolve(spelled), '/')
      }
      const above = resolvePath(resolve(spelled.slice(0, cut) || '/'), '/')
      return `${above.replace(/\/+$/, '')}/${name}`
    } catch (err) {
      if (err instanceof CycleError) throw eloop(path)
      throw err
    }
  }

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
    const desc: Descriptor = { path, mode, handle: null, kept: null, opened: path }
    // What other descriptors on the file still owe lands first, so their
    // older writes never land over what this one writes.
    if (mode.writable) await this.landPath(path)
    if (row?.isDir !== true || mode.writable || mode.create) {
      const opened = await applyOpen(this.files, path, mode)
      desc.handle = FileHandle.opened(
        path,
        opened === null ? null : this.fetch(desc, mode.writable),
        { size: opened?.size ?? 0, writable: mode.writable, append: mode.append },
      )
    }
    desc.path = this.walked(path)
    desc.opened = desc.path
    const fd = (this.native.openSync as (p: string, f: string) => number)(devNull, 'r')
    this.table.set(fd, desc)
    return fd
  }

  /** A descriptor's ranged read: what it kept once its name went, else
   * what is at its path now. */
  private fetch(desc: Descriptor, raw: boolean): FileFetch {
    return (offset, size) => {
      const kept = desc.kept
      if (kept !== null) {
        if (kept.error !== null) return Promise.reject(kept.error)
        return Promise.resolve(kept.data.slice(offset, size === null ? undefined : offset + size))
      }
      return this.files.read(desc.path, size === null ? { raw } : { offset, size, raw })
    }
  }

  /** Land a descriptor's writes on the mount; one whose name went lands
   * them on what its file kept, which every other descriptor on it reads,
   * as writes to an unlinked file stay with it. */
  async land(desc: Descriptor): Promise<void> {
    const handle = desc.handle
    if (handle === null) return
    if (desc.kept !== null) {
      if (handle.dirty) {
        desc.kept.data = await readAt(handle, 0, handle.size)
        handle.settle(this.fetch(desc, true))
      }
      return
    }
    const steps = handle.flushPlan()
    if (steps.length === 0) return
    await this.files.flush(desc.path, steps)
    handle.settle(this.fetch(desc, true))
  }

  /** Land the writes of every descriptor open on `path`, which a change of
   * its times must come after. */
  async landPath(path: string): Promise<void> {
    const named = this.walked(path)
    for (const [fd, desc] of this.table) {
      if (desc.path === named) await this.serial(fd, () => this.land(desc))
    }
  }

  /** Follow a rename: a descriptor on `old` or under it names the same
   * file at `next` now. */
  moved(old: string, next: string): void {
    const from = this.walked(old, false)
    const to = this.walked(next, false)
    const under = `${from.replace(/\/+$/, '')}/`
    for (const desc of this.table.values()) {
      if (desc.kept === null && (desc.path === from || desc.path.startsWith(under))) {
        desc.path = to + desc.path.slice(from.length)
      }
    }
  }

  /** Read what the descriptors open on `path` need before its name is
   * removed or replaced; `keep` them once it has gone. They share one read,
   * and a read that fails (a policy refusing it, say) is kept as the error
   * later reads report, so the removal it allows goes ahead. */
  async hold(path: string): Promise<[Descriptor, Kept][]> {
    const named = this.walked(path, false)
    const held = [...this.table.values()].filter(
      (desc) => desc.path === named && desc.kept === null && desc.handle !== null,
    )
    const kept: Kept = { data: new Uint8Array(), error: null }
    // A file no descriptor can read needs nothing kept.
    if (held.some((desc) => desc.mode.readable)) {
      try {
        kept.data = await this.files.read(named, {
          raw: held.some((desc) => desc.mode.writable),
        })
      } catch (err) {
        console.warn(`host: keeping ${named} before it goes failed`, err)
        kept.error = err instanceof Error ? err : new Error(String(err))
      }
    }
    return held.map((desc) => [desc, kept])
  }

  /** Detach the descriptors `hold` read for, now their name went. */
  keep(held: [Descriptor, Kept][]): void {
    for (const [desc, kept] of held) desc.kept = kept
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
