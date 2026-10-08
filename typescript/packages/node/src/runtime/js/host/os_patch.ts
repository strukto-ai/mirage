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
import { workspaceBridge } from '@struktoai/mirage-core/runtime/binding'
import { RuntimeFiles } from '@struktoai/mirage-core/runtime/files'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'

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
  const m = ws.registry.tryMountFor(p)
  if (m === null) return false
  // The synthetic root anchor is an empty internal mount that matches every
  // path; it does not back real files, so paths caught only by it fall
  // through to the native fs. A user-provided `/` mount is honored.
  if (ws.syntheticRoot && m === ws.registry.rootMount) return false
  return true
}

async function mirageStat(vfs: RuntimeFiles, p: string): Promise<unknown> {
  const s = await vfs.stat(p)
  const mtime = new Date(s.mtimeMs ?? 0)
  const atime = s.atimeMs === undefined ? mtime : new Date(s.atimeMs)
  return {
    isFile: () => !s.isDir,
    isDirectory: () => s.isDir,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    size: s.size,
    mtime,
    mtimeMs: mtime.getTime(),
    atime,
    atimeMs: atime.getTime(),
    ctime: mtime,
    ctimeMs: mtime.getTime(),
    birthtime: mtime,
    birthtimeMs: mtime.getTime(),
    mode: s.mode,
    nlink: 1,
    uid: s.uid ?? 0,
    gid: s.gid ?? 0,
    rdev: 0,
    blksize: 0,
    blocks: 0,
    dev: 0,
    ino: 0,
  }
}

/** A listing row's final segment: node's readdir answers names. */
function leaf(entry: string): string {
  const trimmed = entry.endsWith('/') ? entry.slice(0, -1) : entry
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

/**
 * Monkey-patch Node's `fs` module so that paths under any mirage mount
 * route through the workspace. Paths NOT under a mount fall through to
 * the real native fs. CJS-friendly; for ESM code you still need to use
 * `ws.vfs.*` directly since ESM bindings are frozen.
 *
 * The patched calls ride the runtimes' file door (`RuntimeFiles`) over
 * `ws.vfs.dispatch`, so they run as the facade's session and land in
 * `ws.vfs.records`, as Python's `with ws:` block does.
 *
 * Returns a `restore()` function that undoes the patch.
 */
export function patchNodeFs(ws: Workspace): () => void {
  const originalFs: FsLike = { ...(fs as unknown as FsLike) }
  const vfs = new RuntimeFiles(
    workspaceBridge((name, path, args, kwargs) => ws.vfs.dispatch(name, path, args, kwargs)),
  )

  const vol: FsLike = {
    promises: {
      readFile: async (p: string, opts?: { encoding?: BufferEncoding } | BufferEncoding) => {
        if (mountedPath(ws, p)) {
          const bytes = await vfs.read(p)
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
          await vfs.write(p, typeof data === 'string' ? new TextEncoder().encode(data) : data)
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
          return (await vfs.readdir(p, false)).map((row) => leaf(row.path))
        }
        const native = (originalFs.promises as FsLike).readdir as (
          path: string,
        ) => Promise<string[]>
        return native(p)
      },
      stat: async (p: string): Promise<unknown> => {
        if (mountedPath(ws, p)) return mirageStat(vfs, p)
        const native = (originalFs.promises as FsLike).stat as (path: string) => Promise<unknown>
        return native(p)
      },
      unlink: async (p: string): Promise<void> => {
        if (mountedPath(ws, p)) return vfs.unlink(p)
        const native = (originalFs.promises as FsLike).unlink as (path: string) => Promise<void>
        await native(p)
      },
      mkdir: async (p: string): Promise<void> => {
        if (mountedPath(ws, p)) return vfs.mkdir(p)
        const native = (originalFs.promises as FsLike).mkdir as (path: string) => Promise<void>
        await native(p)
      },
      rmdir: async (p: string): Promise<void> => {
        if (mountedPath(ws, p)) return vfs.rmdir(p)
        const native = (originalFs.promises as FsLike).rmdir as (path: string) => Promise<void>
        await native(p)
      },
    },
    readFileSync: (): Uint8Array => {
      throw new Error('mirage.patchNodeFs: sync fs methods not supported — use fs.promises.*')
    },
    readFile: (p: string, cb: Cb<Uint8Array>) => {
      if (mountedPath(ws, p)) {
        vfs
          .read(p)
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
        vfs
          .readdir(p, false)
          .then((rows) => {
            cb(
              null,
              rows.map((row) => leaf(row.path)),
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
