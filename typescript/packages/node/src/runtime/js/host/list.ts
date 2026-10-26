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
import type { VFSEntry } from '@struktoai/mirage-core/runtime/types'

const { S_IFMT, S_IFREG, S_IFDIR, S_IFCHR, S_IFLNK } = constants

/**
 * One node `Dirent` for a mounted directory's row, the twin of python's
 * `MountDirEntry`. Its kind is the one the listing reported.
 *
 * @param directory - the directory listed.
 * @param row - the listing's row for the entry.
 * @param name - its name in the encoding the call asked for.
 */
export function dirent(directory: string, row: VFSEntry, name: unknown): unknown {
  const kind = row.isLink === true ? S_IFLNK : row.isDir ? S_IFDIR : (row.mode ?? 0) & S_IFMT
  return {
    name,
    parentPath: directory,
    path: directory,
    isFile: () => kind === S_IFREG,
    isDirectory: () => kind === S_IFDIR,
    isBlockDevice: () => false,
    isCharacterDevice: () => kind === S_IFCHR,
    isSymbolicLink: () => kind === S_IFLNK,
    isFIFO: () => false,
    isSocket: () => false,
  }
}

/**
 * The `Dir` node's `opendir` answers, over a listing already read, the
 * twin of python's `MountScandir`. The listing is read whole as the
 * directory opens, where node reads a batch at a time: a caller cannot
 * tell the two apart, and the sync reads then need no workspace call.
 *
 * @param path - the directory opened.
 * @param entries - its `Dirent`s.
 */
export function openedDir(path: string, entries: unknown[]): unknown {
  let closed = false
  const refused = (): Error =>
    Object.assign(new Error('Directory handle was closed'), { code: 'ERR_DIR_CLOSED' })
  const readSync = (): unknown => {
    if (closed) throw refused()
    return entries.shift() ?? null
  }
  const closeSync = (): void => {
    if (closed) throw refused()
    closed = true
  }
  const read = (): Promise<unknown> => Promise.resolve().then(readSync)
  // A call with a callback answers it and returns nothing, as node's do.
  const settle = (work: () => unknown, done: unknown): Promise<unknown> | undefined => {
    const settled = Promise.resolve().then(work)
    if (typeof done !== 'function') return settled
    settled.then(
      (value) => {
        ;(done as (err: unknown, value?: unknown) => void)(null, value)
      },
      (err: unknown) => {
        ;(done as (err: unknown) => void)(err)
      },
    )
    return undefined
  }
  return {
    path,
    read: (done?: unknown) => settle(readSync, done),
    readSync,
    close: (done?: unknown) => settle(closeSync, done),
    closeSync,
    async *[Symbol.asyncIterator]() {
      try {
        for (let entry = await read(); entry !== null; entry = await read()) yield entry
      } finally {
        if (!closed) closeSync()
      }
    },
    [Symbol.asyncDispose]: () => {
      if (!closed) closeSync()
      return Promise.resolve()
    },
    [Symbol.dispose]: () => {
      if (!closed) closeSync()
    },
  }
}
