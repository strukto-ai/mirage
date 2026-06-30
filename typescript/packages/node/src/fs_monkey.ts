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
import { createRequire } from 'node:module'
import { FileType, type Workspace } from '@struktoai/mirage-core'

const requireCjs = createRequire(import.meta.url)
const fs = requireCjs('node:fs') as Record<string, unknown>
// fs-monkey ships no types
const fsMonkey = requireCjs('fs-monkey') as {
  patchFs: (vol: unknown, target?: unknown) => void
}
const { patchFs } = fsMonkey

type Cb<T> = (err: NodeJS.ErrnoException | null, value?: T) => void

type FsLike = Record<string, unknown>

function mountedPath(ws: Workspace, p: string): boolean {
  try {
    const m = ws.registry.mountFor(p)
    if (m === null) return false
    // The synthetic root anchor is an empty internal mount that matches every
    // path; it does not back real files, so paths caught only by it fall
    // through to the native fs. A user-provided `/` mount is honored.
    if (ws.syntheticRoot && m === ws.registry.rootMount) return false
    return true
  } catch {
    return false
  }
}

async function mirageStat(ws: Workspace, p: string): Promise<unknown> {
  const s = await ws.fs.stat(p)
  const isDir = s.type === FileType.DIRECTORY
  const mtime = s.modified !== null ? new Date(s.modified) : new Date(0)
  return {
    isFile: () => !isDir,
    isDirectory: () => isDir,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    size: s.size ?? 0,
    mtime,
    mtimeMs: mtime.getTime(),
    atime: mtime,
    atimeMs: mtime.getTime(),
    ctime: mtime,
    ctimeMs: mtime.getTime(),
    birthtime: mtime,
    birthtimeMs: mtime.getTime(),
    mode: 0,
    nlink: 1,
    uid: 0,
    gid: 0,
    rdev: 0,
    blksize: 0,
    blocks: 0,
    dev: 0,
    ino: 0,
  }
}

/**
 * Monkey-patch Node's `fs` module so that paths under any mirage mount
 * route through the workspace. Paths NOT under a mount fall through to
 * the real native fs. CJS-friendly; for ESM code you still need to use
 * `ws.fs.*` directly since ESM bindings are frozen.
 *
 * Returns a `restore()` function that undoes the patch.
 */
export function patchNodeFs(ws: Workspace): () => void {
  const originalFs: FsLike = { ...(fs as unknown as FsLike) }

  const vol: FsLike = {
    promises: {
      readFile: async (p: string, opts?: { encoding?: BufferEncoding } | BufferEncoding) => {
        if (mountedPath(ws, p)) {
          const bytes = await ws.fs.readFile(p)
          const encoding = typeof opts === 'string' ? opts : opts?.encoding
          if (encoding !== undefined) return Buffer.from(bytes).toString(encoding)
          return Buffer.from(bytes)
        }
        const native = (originalFs.promises as FsLike).readFile as (
          path: string,
          opts?: unknown,
        ) => Promise<Uint8Array | string>
        return native(p, opts)
      },
      writeFile: async (p: string, data: Uint8Array | string): Promise<void> => {
        if (mountedPath(ws, p)) {
          await ws.fs.writeFile(p, typeof data === 'string' ? data : data)
          return
        }
        const native = (originalFs.promises as FsLike).writeFile as (
          path: string,
          data: Uint8Array | string,
        ) => Promise<void>
        await native(p, data)
      },
      readdir: async (p: string): Promise<string[]> => {
        if (mountedPath(ws, p)) {
          // Workspace returns full paths; Node's fs.promises.readdir returns basenames.
          // Strip trailing slash on directory entries before slicing so dirs
          // don't collapse to ''.
          const entries = await ws.fs.readdir(p)
          return entries.map((e) => {
            const trimmed = e.endsWith('/') ? e.slice(0, -1) : e
            return trimmed.slice(trimmed.lastIndexOf('/') + 1)
          })
        }
        const native = (originalFs.promises as FsLike).readdir as (
          path: string,
        ) => Promise<string[]>
        return native(p)
      },
      stat: async (p: string): Promise<unknown> => {
        if (mountedPath(ws, p)) return mirageStat(ws, p)
        const native = (originalFs.promises as FsLike).stat as (path: string) => Promise<unknown>
        return native(p)
      },
      unlink: async (p: string): Promise<void> => {
        if (mountedPath(ws, p)) return ws.fs.unlink(p)
        const native = (originalFs.promises as FsLike).unlink as (path: string) => Promise<void>
        await native(p)
      },
      mkdir: async (p: string): Promise<void> => {
        if (mountedPath(ws, p)) return ws.fs.mkdir(p)
        const native = (originalFs.promises as FsLike).mkdir as (path: string) => Promise<void>
        await native(p)
      },
      rmdir: async (p: string): Promise<void> => {
        if (mountedPath(ws, p)) return ws.fs.rmdir(p)
        const native = (originalFs.promises as FsLike).rmdir as (path: string) => Promise<void>
        await native(p)
      },
    },
    readFileSync: (): Uint8Array => {
      throw new Error('mirage.patchNodeFs: sync fs methods not supported — use fs.promises.*')
    },
    readFile: (p: string, cb: Cb<Uint8Array>) => {
      if (mountedPath(ws, p)) {
        ws.fs
          .readFile(p)
          .then((data) => {
            cb(null, Buffer.from(data))
          })
          .catch((err: unknown) => {
            cb(err as NodeJS.ErrnoException)
          })
        return
      }
      const native = originalFs.readFile as (path: string, cb: Cb<Uint8Array>) => void
      native(p, cb)
    },
    readdir: (p: string, cb: Cb<string[]>) => {
      if (mountedPath(ws, p)) {
        ws.fs
          .readdir(p)
          .then((entries) => {
            cb(
              null,
              entries.map((e) => {
                const trimmed = e.endsWith('/') ? e.slice(0, -1) : e
                return trimmed.slice(trimmed.lastIndexOf('/') + 1)
              }),
            )
          })
          .catch((err: unknown) => {
            cb(err as NodeJS.ErrnoException)
          })
        return
      }
      const native = originalFs.readdir as (path: string, cb: Cb<string[]>) => void
      native(p, cb)
    },
  }

  patchFs(vol, fs)
  return function restore(): void {
    for (const [k, v] of Object.entries(originalFs)) {
      const desc = Object.getOwnPropertyDescriptor(fs, k)
      if (desc?.writable === false && desc.set === undefined) continue
      try {
        fs[k] = v
      } catch {
        // some fs properties are accessor-only and can't be reassigned; skip
      }
    }
  }
}
