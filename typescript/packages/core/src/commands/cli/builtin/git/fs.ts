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

import { FileType, PathSpec } from '../../../../types.ts'
import type { FileStat } from '../../../../types.ts'
import { enoent } from '../../../../utils/errors.ts'
import { basename } from './path.ts'
import { ensureDir, exists, readNames, removeFile } from './io.ts'
import type { Dispatch } from './types.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

/**
 * The stat shape isomorphic-git reads. It consults `type`, `mode`, `size` and
 * the mtime, and calls `isDirectory()`/`isFile()`/`isSymbolicLink()`; the
 * numeric device fields feed its index stat cache, which mirage zeroes on
 * purpose so nothing downstream trusts it (see IndexEntry in types.ts).
 */
class GitStat {
  readonly type: 'file' | 'dir'
  readonly mode: number
  readonly size: number
  readonly ino = 0
  readonly dev = 0
  readonly uid = 0
  readonly gid = 0
  readonly ctimeMs: number
  readonly mtimeMs: number
  readonly ctimeSeconds: number
  readonly mtimeSeconds: number
  readonly ctimeNanoseconds = 0
  readonly mtimeNanoseconds = 0

  constructor(stat: FileStat) {
    const dir = stat.type === FileType.DIRECTORY
    this.type = dir ? 'dir' : 'file'
    this.mode = stat.mode ?? (dir ? 0o040755 : 0o100644)
    this.size = stat.size ?? 0
    const ms = stat.modified === null ? 0 : Date.parse(stat.modified) || 0
    this.ctimeMs = ms
    this.mtimeMs = ms
    this.ctimeSeconds = Math.floor(ms / 1000)
    this.mtimeSeconds = Math.floor(ms / 1000)
  }

  isDirectory(): boolean {
    return this.type === 'dir'
  }

  isFile(): boolean {
    return this.type === 'file'
  }

  isSymbolicLink(): boolean {
    return false
  }
}

/**
 * A `PromiseFsClient` whose bytes come from a mirage mount.
 *
 * isomorphic-git reaches a repository through nothing but this object, so a
 * repository on S3, in RAM or over SSH is the same repository to it. That is
 * the whole bridge, and it is why the TypeScript side needs no counterpart to
 * Python's `objects.py`/`lazyfile.py`: dulwich's object store is synchronous, so
 * Python has to hand-build a lazy store and marshal every read onto the
 * workspace loop, while isomorphic-git is async to begin with and reads
 * packfiles, loose objects and the index itself.
 *
 * Symlinks are refused rather than faked. mirage keeps links in the namespace
 * rather than in any backend, so a `readlink` here would have to consult a
 * different layer than every other call, and no verb mirrored so far writes or
 * follows one inside a `.git` directory.
 */
export function gitFs(dispatch: Dispatch): {
  promises: Record<string, (...args: never[]) => Promise<unknown>>
} {
  const readFile = async (path: string, options?: string | { encoding?: string }) => {
    const encoding = typeof options === 'string' ? options : options?.encoding
    const [data] = await dispatch('read', PathSpec.fromStrPath(path))
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBufferLike)
    return encoding === undefined ? bytes : DEC.decode(bytes)
  }

  const writeFile = async (path: string, data: Uint8Array | string) => {
    const bytes = typeof data === 'string' ? ENC.encode(data) : data
    await ensureDir(dispatch, path.slice(0, path.lastIndexOf('/')) || '/')
    await dispatch('write', PathSpec.fromStrPath(path), [bytes])
  }

  const stat = async (path: string) => {
    const [got] = await dispatch('stat', PathSpec.fromStrPath(path))
    if (got === null) throw enoent(path)
    return new GitStat(got as FileStat)
  }

  return {
    promises: {
      readFile,
      writeFile,
      unlink: async (path: string) => {
        await removeFile(dispatch, path)
      },
      // isomorphic-git wants bare names; backends may report either those or
      // whole paths, with or without a trailing slash.
      readdir: async (path: string) => (await readNames(dispatch, path)).map(basename),
      mkdir: async (path: string) => {
        await ensureDir(dispatch, path)
      },
      rmdir: async (path: string) => {
        await dispatch('rmdir', PathSpec.fromStrPath(path))
      },
      stat,
      // A mount has no links below it, so lstat is stat.
      lstat: stat,
      readlink: () => Promise.reject(new Error('mirage git: symlinks are not read here')),
      symlink: () => Promise.reject(new Error('mirage git: symlinks are not written here')),
      // git chmods a loose object to 0444; the mount decides its own modes and
      // writeOnce never rewrites one, so there is nothing to enforce.
      chmod: () => Promise.resolve(),
      exists: (path: string) => exists(dispatch, path),
    } as unknown as Record<string, (...args: never[]) => Promise<unknown>>,
  }
}
