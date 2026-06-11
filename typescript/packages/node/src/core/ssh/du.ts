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

import type { FileEntryWithStats } from 'ssh2'
import type { PathSpec } from '@struktoai/mirage-core'
import type { SSHAccessor } from '../../accessor/ssh.ts'
import { isDirectoryAttrs, isFileAttrs, joinRoot, stripPrefix } from './utils.ts'
import { norm } from '@struktoai/mirage-core'

async function readRemoteDir(
  accessor: SSHAccessor,
  remote: string,
): Promise<FileEntryWithStats[] | null> {
  const sftp = await accessor.sftp()
  return new Promise<FileEntryWithStats[] | null>((resolveFn, rejectFn) => {
    sftp.readdir(remote, (err, entries) => {
      if (err !== undefined) {
        const code = (err as { code?: unknown }).code
        if (code === 2) {
          resolveFn(null)
          return
        }
        rejectFn(err)
        return
      }
      resolveFn(entries)
    })
  })
}

async function statRemote(
  accessor: SSHAccessor,
  remote: string,
): Promise<{ mode: number; size: number } | null> {
  const sftp = await accessor.sftp()
  return new Promise<{ mode: number; size: number } | null>((resolveFn, rejectFn) => {
    sftp.lstat(remote, (err, stats) => {
      if (err !== undefined) {
        const code = (err as { code?: unknown }).code
        if (code === 2) {
          resolveFn(null)
          return
        }
        rejectFn(err)
        return
      }
      resolveFn({ mode: stats.mode, size: stats.size })
    })
  })
}

async function walkSizes(accessor: SSHAccessor, virtual: string): Promise<number> {
  const remote = joinRoot(accessor.config.root ?? '/', virtual)
  const st = await statRemote(accessor, remote)
  if (st === null) return 0
  if (isFileAttrs(st)) return st.size
  if (!isDirectoryAttrs(st)) return 0
  const entries = await readRemoteDir(accessor, remote)
  if (entries === null) return 0
  let total = 0
  for (const entry of entries) {
    if (entry.filename === '.' || entry.filename === '..') continue
    const child = virtual === '/' ? `/${entry.filename}` : `${virtual}/${entry.filename}`
    if (isDirectoryAttrs(entry.attrs)) {
      total += await walkSizes(accessor, child)
    } else {
      total += entry.attrs.size
    }
  }
  return total
}

async function walkAll(
  accessor: SSHAccessor,
  virtual: string,
  entries: [string, number][],
): Promise<number> {
  const remote = joinRoot(accessor.config.root ?? '/', virtual)
  const st = await statRemote(accessor, remote)
  if (st === null) return 0
  if (isFileAttrs(st)) {
    entries.push([virtual, st.size])
    return st.size
  }
  if (!isDirectoryAttrs(st)) return 0
  const list = await readRemoteDir(accessor, remote)
  if (list === null) return 0
  let total = 0
  for (const entry of list) {
    if (entry.filename === '.' || entry.filename === '..') continue
    const child = virtual === '/' ? `/${entry.filename}` : `${virtual}/${entry.filename}`
    if (isDirectoryAttrs(entry.attrs)) {
      total += await walkAll(accessor, child, entries)
    } else {
      const size = entry.attrs.size
      entries.push([child, size])
      total += size
    }
  }
  return total
}

export async function du(accessor: SSHAccessor, p: PathSpec): Promise<number> {
  const virtual = stripPrefix(p)
  return walkSizes(accessor, virtual)
}

export async function duAll(
  accessor: SSHAccessor,
  p: PathSpec,
): Promise<[entries: [string, number][], total: number]> {
  const virtual = norm(stripPrefix(p))
  const entries: [string, number][] = []
  const total = await walkAll(accessor, virtual, entries)
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return [entries, total]
}
